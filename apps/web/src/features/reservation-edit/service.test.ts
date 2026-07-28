/**
 * executeEditCascade — step ordering, forward recovery, locks, and gates.
 * Every I/O module is mocked; the tests assert the money choreography:
 * capture is persisted before any downstream step, failures finish the
 * ledger row as 'failed' with the captured payment ids intact, and the
 * sub-flag gates refuse BEFORE any money moves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({
  default: { set: vi.fn(async () => "OK"), del: vi.fn(async () => 1), get: vi.fn() },
}));
vi.mock("@/lib/bowling-db", () => ({
  getBowlingReservation: vi.fn(),
  getReservationPlayersWithShoeAllowance: vi.fn(async () => ({
    players: [{ slot: 1, name: "Ann", shoeSize: null, bumpers: null }],
    shoePairsAllowed: 0,
  })),
  getBowlingExperiences: vi.fn(async () => []),
  updateReservationAfterEdit: vi.fn(async () => {}),
  updateStoreCreditIssued: vi.fn(async () => {}),
}));
vi.mock("@/lib/reservation-edit-log", () => ({
  nextEditAttempt: vi.fn(async () => 1),
  startEditEvent: vi.fn(async () => {}),
  finishEditEvent: vi.fn(async () => {}),
  recordEditPayment: vi.fn(async () => {}),
  recordEditRefund: vi.fn(async () => {}),
  markEditPendingPayment: vi.fn(async () => {}),
  listEditEventsByAnchors: vi.fn(async () => []),
  getLatestEditEvent: vi.fn(async () => null),
  getOpenEditEvent: vi.fn(async () => null),
  refundedCentsForPayment: vi.fn(async () => ({ cents: 0, refundIds: [] })),
}));
vi.mock("@/lib/reservation-cancel-log", () => ({
  getLatestCancelEvent: vi.fn(async () => null),
}));
vi.mock("@/lib/square-gift-card", () => ({
  loadGiftCard: vi.fn(async () => ({ balanceCents: 9999 })),
  mintDigitalGiftCard: vi.fn(async () => ({ giftCardId: "GC_NEW", gan: "7783" })),
  refundSquarePayment: vi.fn(async () => ({ refundId: "RF_FULL", status: "COMPLETED" })),
}));
vi.mock("~/features/reservations-admin/audit", () => ({
  recordAdminAction: vi.fn(async () => {}),
}));
vi.mock("~/features/cancellation/square-actions", () => ({
  sq: vi.fn(),
  fetchOrderFacts: vi.fn(),
  fetchGiftCardFacts: vi.fn(async () => ({
    id: "GC1",
    gan: "WEBHPFM123",
    state: "ACTIVE",
    balanceCents: 5000,
    locationId: "TXBSQN0FEKQ11",
  })),
  fetchPaymentFacts: vi.fn(),
}));
vi.mock("./square-actions", () => ({
  createEditTopupOrderAndCharge: vi.fn(async () => ({ orderId: "TOP1", paymentId: "PAY_TOP" })),
  refundTenderPartial: vi.fn(async () => ({ refundId: "RF1", refundedCents: 500 })),
  fetchRefundFacts: vi.fn(async () => ({ paymentId: "?", amountCents: 0, status: "COMPLETED" })),
  adjustGiftCardDown: vi.fn(async () => 500),
  updateDayofOrderLines: vi.fn(async () => ({ totalCents: 9999, version: 4 })),
  chargeDayofOrder: vi.fn(async () => ({ paymentId: "PAY_MID" })),
  waitForRefundCredit: vi.fn(async () => ({ settled: true, status: "COMPLETED" })),
  createReturnOrder: vi.fn(async () => ({ returnOrderId: "RET1", returnTotalCents: 1605 })),
}));
vi.mock("./qamf-sync", () => ({
  syncQamfPlayers: vi.fn(async () => ({ lanesUpdated: 1 })),
  playersToQamfRoster: vi.fn((players: unknown[], n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `Bowler ${i + 1}` })),
  ),
  rebookQamfForLaneChange: vi.fn(async () => ({ newQamfId: "Q_NEW" })),
}));
vi.mock("./bmi-sync", () => ({
  syncBmiRaceEdit: vi.fn(async () => ({ detail: "booked" })),
}));

import redis from "@/lib/redis";
import { getBowlingReservation, updateReservationAfterEdit } from "@/lib/bowling-db";
import {
  finishEditEvent,
  getOpenEditEvent,
  listEditEventsByAnchors,
  markEditPendingPayment,
  nextEditAttempt,
  recordEditPayment,
  recordEditRefund,
  refundedCentsForPayment,
  startEditEvent,
} from "@/lib/reservation-edit-log";
import { loadGiftCard } from "@/lib/square-gift-card";
import { fetchOrderFacts, fetchPaymentFacts } from "~/features/cancellation/square-actions";
import {
  adjustGiftCardDown,
  createEditTopupOrderAndCharge,
  createReturnOrder,
  fetchRefundFacts,
  refundTenderPartial,
  updateDayofOrderLines,
  waitForRefundCredit,
} from "./square-actions";
import { syncBmiRaceEdit } from "./bmi-sync";

import type { EditPlan } from "./plan";
import { executeEditCascade } from "./service";
import { EditGuardError, type EditStep } from "./types";

const ROW = {
  id: 42,
  centerCode: "fort-myers",
  productKind: "open",
  qamfReservationId: "Q1",
  squareDepositOrderId: "DEP1",
  squareDayofOrderId: "O1",
  squareGiftCardId: "GC1",
  squareGiftCardGan: "WEBHPFM123",
  depositCents: 5000,
  totalCents: 5000,
  status: "confirmed",
  bookedAt: "2026-08-01T14:00:00-04:00",
  playerCount: 2,
  guestName: "Ann Guest",
  squareCustomerId: "CUST1",
  refundCents: 0,
  rewardDiscountCents: 0,
  promoSavingsCents: 0,
  storeCreditCents: 0,
  attractionBookings: [],
  qamfConfirmAttempts: 0,
  bookingMetadata: {
    bowling: {
      experienceSlug: "fun-4-all",
      laneCount: 1,
      durationMultiplier: 1,
      pricingMode: "per_person",
    },
  },
  insertedAt: "",
  lines: [],
};

const mkPlan = (steps: EditStep[], over: Partial<EditPlan> = {}): EditPlan => ({
  anchorId: 42,
  legIds: [42],
  isCombo: false,
  phase: "pre",
  spec: { playerCount: 4 },
  legs: [
    {
      reservationId: 42,
      productKind: "open",
      dayofOrderId: "O1",
      orderState: "OPEN",
      orderVersion: 3,
      orderLocationId: "TXBSQN0FEKQ11",
      phase: "pre",
      oldLines: [],
      newLines: [],
      oldTotalCents: 5000,
      newTotalCents: 9999,
      returnedLines: [],
      newNeonLines: [
        {
          squareProductId: 1,
          squareCatalogObjectId: "CAT_OPEN",
          label: "Fun 4 All",
          quantity: 4,
          unitPriceCents: 1999,
          role: "primary",
        },
      ],
      newPlayerCount: 4,
      newLaneCount: 1,
      newDuration: null,
      resolvedStamp: null,
      removedHeats: null,
      raceAdds: null,
      attractionChanges: null,
    },
  ],
  diffCents: 4999,
  guestOwedCents: 0,
  gcDecrementCents: 0,
  settlement: "charge",
  chargeCard: { cardId: "ccof:CARD1", brand: "VISA", last4: "4242" },
  giftCard: { id: "GC1", gan: "WEBHPFM123", balanceCents: 5000, state: "ACTIVE" },
  steps,
  warnings: [],
  current: {
    playerCount: 2,
    laneCount: 1,
    pricingMode: "per_person",
    shoes: [],
    shoeCatalog: [],
    players: [],
    heats: [],
    durationOptions: [],
    durationMultiplier: null,
    attractions: [],
    orderLines: [],
  },
  planHash: "abc123",
  ...over,
});

const PRE_INCREASE_STEPS: EditStep[] = [
  { kind: "audit_start", fatal: true },
  { kind: "charge_topup", fatal: true, amountCents: 4999 },
  { kind: "load_gift_card", fatal: true, target: "GC1", amountCents: 4999 },
  { kind: "update_dayof_order", fatal: true, target: "O1", amountCents: 4999 },
  { kind: "neon_commit", fatal: true },
  { kind: "qamf_set_players", fatal: false, target: "Q1" },
  { kind: "notify", fatal: false },
];

const baseReq = (plan: EditPlan) => ({
  plan,
  notifyGuest: false,
  actor: "admin",
  origin: "https://test.local",
});

beforeEach(() => {
  vi.mocked(getBowlingReservation).mockResolvedValue(ROW as never);
  vi.mocked(fetchOrderFacts).mockResolvedValue({
    id: "O1",
    state: "OPEN",
    version: 3,
    locationId: "TXBSQN0FEKQ11",
    tenderCount: 0,
    netDueCents: 5000,
    totalCents: 5000,
    tenders: [],
  } as never);
  vi.mocked(redis.set).mockResolvedValue("OK" as never);
  // Defaults reset per test — mockResolvedValue persists past clearAllMocks.
  vi.mocked(getOpenEditEvent).mockResolvedValue(null);
  vi.mocked(refundedCentsForPayment).mockResolvedValue({ cents: 0, refundIds: [] });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.RESERVATION_EDIT_V2_RACE;
});

const guardCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof EditGuardError) return e.code;
    throw e;
  }
  throw new Error("expected EditGuardError");
};

describe("executeEditCascade — PRE increase", () => {
  it("runs the money choreography in order and completes the ledger row", async () => {
    const result = await executeEditCascade(baseReq(mkPlan(PRE_INCREASE_STEPS)));

    expect(result.state).toBe("completed");
    expect(result.paymentIds).toEqual(["PAY_TOP"]);

    // Payment persisted the moment it landed — BEFORE the gift-card load.
    const paymentOrder = vi.mocked(recordEditPayment).mock.invocationCallOrder[0];
    const loadOrder = vi.mocked(loadGiftCard).mock.invocationCallOrder[0];
    const putOrder = vi.mocked(updateDayofOrderLines).mock.invocationCallOrder[0];
    const neonOrder = vi.mocked(updateReservationAfterEdit).mock.invocationCallOrder[0];
    expect(paymentOrder).toBeLessThan(loadOrder);
    expect(loadOrder).toBeLessThan(putOrder);
    expect(putOrder).toBeLessThan(neonOrder);

    expect(vi.mocked(startEditEvent)).toHaveBeenCalledOnce();
    expect(vi.mocked(finishEditEvent)).toHaveBeenCalledWith(
      "edit-42-a1",
      expect.objectContaining({ state: "completed", paymentIds: ["PAY_TOP"] }),
    );
    // Deposit == day-of total invariant: PRE commits deposit = new total.
    expect(vi.mocked(updateReservationAfterEdit)).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ totalCents: 9999, depositCents: 9999 }),
    );
  });

  it("persists the plan-resolved stamp (self-heal) with the lane override applied", async () => {
    const base = mkPlan(PRE_INCREASE_STEPS);
    const plan = {
      ...base,
      legs: [
        {
          ...base.legs[0],
          resolvedStamp: {
            experienceSlug: "fun-4-all",
            laneCount: 1,
            durationMultiplier: 1,
            pricingMode: "per_person" as const,
          },
          newLaneCount: 2,
        },
      ],
    };
    await executeEditCascade(baseReq(plan));
    expect(vi.mocked(updateReservationAfterEdit)).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        bowlingStamp: {
          experienceSlug: "fun-4-all",
          laneCount: 2,
          durationMultiplier: 1,
          pricingMode: "per_person",
        },
      }),
    );
  });

  it("leaves booking_metadata untouched when the plan resolved no stamp (carry mode)", async () => {
    await executeEditCascade(baseReq(mkPlan(PRE_INCREASE_STEPS)));
    const update = vi.mocked(updateReservationAfterEdit).mock.calls[0][1];
    expect(update.bowlingStamp).toBeUndefined();
  });

  it("a failed order PUT finishes the row as failed and keeps the payment ids", async () => {
    vi.mocked(updateDayofOrderLines).mockRejectedValueOnce(new Error("VERSION_MISMATCH"));
    await expect(executeEditCascade(baseReq(mkPlan(PRE_INCREASE_STEPS)))).rejects.toThrow(
      "VERSION_MISMATCH",
    );
    expect(vi.mocked(finishEditEvent)).toHaveBeenCalledWith(
      "edit-42-a1",
      expect.objectContaining({ state: "failed", paymentIds: ["PAY_TOP"] }),
    );
    // Neon was never touched after the failure.
    expect(vi.mocked(updateReservationAfterEdit)).not.toHaveBeenCalled();
  });

  it("payment_link stops after marking pending — nothing charges", async () => {
    const steps: EditStep[] = [
      { kind: "audit_start", fatal: true },
      { kind: "await_payment_link", fatal: true, amountCents: 4999 },
      ...PRE_INCREASE_STEPS.slice(1),
    ];
    const result = await executeEditCascade({
      ...baseReq(mkPlan(steps)),
      paymentSource: { kind: "payment_link" },
    });
    expect(result.state).toBe("pending_payment");
    expect(vi.mocked(markEditPendingPayment)).toHaveBeenCalledWith("edit-42-a1");
    expect(vi.mocked(createEditTopupOrderAndCharge)).not.toHaveBeenCalled();
    expect(vi.mocked(finishEditEvent)).toHaveBeenCalledWith(
      "edit-42-a1",
      expect.objectContaining({ state: "pending_payment" }),
    );
  });

  it("refuses when no chargeable card and no payment source", async () => {
    const plan = mkPlan(PRE_INCREASE_STEPS, { chargeCard: null });
    expect(await guardCode(() => executeEditCascade(baseReq(plan)))).toBe("payment_required");
    expect(vi.mocked(finishEditEvent)).toHaveBeenCalledWith(
      "edit-42-a1",
      expect.objectContaining({ state: "failed" }),
    );
  });
});

describe("executeEditCascade — locks and gates", () => {
  it("a held lock refuses with edit_in_progress before any ledger write", async () => {
    vi.mocked(redis.set).mockResolvedValueOnce(null as never);
    expect(await guardCode(() => executeEditCascade(baseReq(mkPlan(PRE_INCREASE_STEPS))))).toBe(
      "edit_in_progress",
    );
    expect(vi.mocked(startEditEvent)).not.toHaveBeenCalled();
  });

  it("a live order that moved since the plan aborts with plan_stale before money", async () => {
    vi.mocked(fetchOrderFacts).mockResolvedValue({
      id: "O1",
      state: "OPEN",
      version: 4,
      locationId: "TXBSQN0FEKQ11",
      tenderCount: 1, // lane-open beat us
      netDueCents: 0,
      totalCents: 5000,
      tenders: [{ paymentId: "PAY_GC", amountCents: 5000 }],
    } as never);
    expect(await guardCode(() => executeEditCascade(baseReq(mkPlan(PRE_INCREASE_STEPS))))).toBe(
      "plan_stale",
    );
    expect(vi.mocked(createEditTopupOrderAndCharge)).not.toHaveBeenCalled();
  });

  it("race steps refuse before money when the race flag is off", async () => {
    const steps: EditStep[] = [
      { kind: "audit_start", fatal: true },
      { kind: "bmi_add_heats", fatal: true, target: "123" },
      ...PRE_INCREASE_STEPS.slice(1),
    ];
    expect(await guardCode(() => executeEditCascade(baseReq(mkPlan(steps))))).toBe(
      "bmi_line_unavailable",
    );
    expect(vi.mocked(createEditTopupOrderAndCharge)).not.toHaveBeenCalled();
    expect(vi.mocked(syncBmiRaceEdit)).not.toHaveBeenCalled();
  });

  it("race steps run when the flag is on", async () => {
    process.env.RESERVATION_EDIT_V2_RACE = "true";
    const steps: EditStep[] = [
      { kind: "audit_start", fatal: true },
      { kind: "bmi_add_heats", fatal: true, target: "123" },
      ...PRE_INCREASE_STEPS.slice(1),
    ];
    const result = await executeEditCascade(baseReq(mkPlan(steps)));
    expect(result.state).toBe("completed");
    expect(vi.mocked(syncBmiRaceEdit)).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "add", origin: "https://test.local" }),
    );
    // Capacity BEFORE money.
    expect(vi.mocked(syncBmiRaceEdit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createEditTopupOrderAndCharge).mock.invocationCallOrder[0],
    );
  });
});

/** Point fetchOrderFacts at a deposit order with the given tenders. */
const depositFacts = (tenders: Array<{ paymentId: string; amountCents: number }>) => {
  vi.mocked(fetchOrderFacts).mockImplementation(async (orderId: string) =>
    orderId === "DEP1"
      ? ({
          id: "DEP1",
          state: "COMPLETED",
          version: 1,
          locationId: "TXBSQN0FEKQ11",
          tenderCount: tenders.length,
          netDueCents: 0,
          totalCents: 5000,
          tenders,
        } as never)
      : ({
          id: "O1",
          state: "OPEN",
          version: 3,
          locationId: "TXBSQN0FEKQ11",
          tenderCount: 0,
          netDueCents: 5000,
          totalCents: 5000,
          tenders: [],
        } as never),
  );
};

describe("executeEditCascade — PRE decrease", () => {
  const DECREASE_STEPS: EditStep[] = [
    { kind: "audit_start", fatal: true },
    { kind: "refund_tender", fatal: true, amountCents: 500 },
    { kind: "adjust_gift_card_down", fatal: true, target: "GC1", amountCents: 500 },
    { kind: "update_dayof_order", fatal: true, target: "O1", amountCents: -500 },
    { kind: "neon_commit", fatal: true },
    { kind: "notify", fatal: false },
  ];

  it("refunds before decrementing the gift card and records refund ids", async () => {
    depositFacts([{ paymentId: "PAY_DEP", amountCents: 5000 }]);
    vi.mocked(fetchPaymentFacts).mockResolvedValue({
      id: "PAY_DEP",
      status: "COMPLETED",
      amountCents: 5000,
      refundedCents: 0,
      sourceType: "CARD",
    } as never);
    vi.mocked(refundTenderPartial).mockResolvedValueOnce({ refundId: "RF1", refundedCents: 500 });

    const result = await executeEditCascade(
      baseReq(mkPlan(DECREASE_STEPS, { diffCents: -500, settlement: "card_refund" })),
    );
    expect(result.refundIds).toEqual(["RF1"]);
    expect(vi.mocked(refundTenderPartial)).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "PAY_DEP",
        amountCents: 500,
        // Owner convention — exact reason on every reservation-money refund.
        reason: "Refund: Reservation Deposit",
        skipGiftCardTender: true,
      }),
    );
    // Forward recovery: the refund id was persisted the moment it landed.
    expect(vi.mocked(recordEditRefund)).toHaveBeenCalledWith("edit-42-a1", "RF1");
  });

  it("refuses a DIFFERENT edit while one is parked, but allows resuming that same id", async () => {
    // §4.3: the plan-time open-event check is only a warning and the Redis
    // lock open-fails; without this guard a second edit plans against stale
    // money facts and re-refunds what the parked attempt already moved.
    vi.mocked(getOpenEditEvent).mockResolvedValue({
      editId: "edit-42-a7",
      state: "started",
    } as never);
    depositFacts([{ paymentId: "PAY_DEP", amountCents: 5000 }]);

    const code = await guardCode(() =>
      executeEditCascade(
        baseReq(mkPlan(DECREASE_STEPS, { diffCents: -500, settlement: "card_refund" })),
      ),
    );
    expect(code).toBe("edit_in_progress");
    expect(vi.mocked(refundTenderPartial)).not.toHaveBeenCalled();
    expect(vi.mocked(startEditEvent)).not.toHaveBeenCalled();

    // Resuming THAT id replays the same idempotency namespace — allowed.
    vi.mocked(fetchPaymentFacts).mockResolvedValue({
      id: "PAY_DEP",
      status: "COMPLETED",
      amountCents: 5000,
      refundedCents: 0,
      sourceType: "CARD",
    } as never);
    await executeEditCascade({
      ...baseReq(mkPlan(DECREASE_STEPS, { diffCents: -500, settlement: "card_refund" })),
      resumeEditId: "edit-42-a7",
    });
    expect(vi.mocked(startEditEvent)).toHaveBeenCalled();
  });

  it("a gift-card-funded deposit tender fails PRE-FLIGHT — before any money moves", async () => {
    depositFacts([{ paymentId: "PAY_GC_DEP", amountCents: 5000 }]);
    // Owed 500 < remaining 5000 → the refund would be PARTIAL → uncoverable.
    vi.mocked(fetchPaymentFacts).mockResolvedValue({
      id: "PAY_GC_DEP",
      status: "COMPLETED",
      amountCents: 5000,
      refundedCents: 0,
      sourceType: "GIFT_CARD",
    } as never);

    await expect(
      executeEditCascade(
        baseReq(mkPlan(DECREASE_STEPS, { diffCents: -500, settlement: "card_refund" })),
      ),
    ).rejects.toThrow(/gift-card tender.*NO money was refunded.*store-credit/);
    // The pre-flight plan refused BEFORE issuing a single refund.
    expect(vi.mocked(refundTenderPartial)).not.toHaveBeenCalled();
    expect(vi.mocked(finishEditEvent)).toHaveBeenCalledWith(
      "edit-42-a1",
      expect.objectContaining({ state: "failed" }),
    );
  });

  it("nets refunds stranded by a prior failed attempt out of the owed amount", async () => {
    depositFacts([{ paymentId: "PAY_DEP", amountCents: 5000 }]);
    vi.mocked(nextEditAttempt).mockResolvedValueOnce(2);
    vi.mocked(listEditEventsByAnchors).mockResolvedValueOnce([
      { editId: "edit-42-a1", state: "failed", paymentIds: [], refundIds: ["RF_OLD"] },
    ] as never);
    vi.mocked(fetchRefundFacts).mockResolvedValueOnce({
      paymentId: "PAY_DEP",
      amountCents: 300,
      status: "COMPLETED",
    });
    vi.mocked(fetchPaymentFacts).mockResolvedValue({
      id: "PAY_DEP",
      status: "COMPLETED",
      amountCents: 5000,
      refundedCents: 300,
      sourceType: "CARD",
    } as never);
    vi.mocked(refundTenderPartial).mockResolvedValueOnce({ refundId: "RF2", refundedCents: 200 });

    const result = await executeEditCascade(
      baseReq(mkPlan(DECREASE_STEPS, { diffCents: -500, settlement: "card_refund" })),
    );
    // Only the 200 not already returned by the stranded refund moves now.
    expect(vi.mocked(refundTenderPartial)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refundTenderPartial)).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "PAY_DEP", amountCents: 200 }),
    );
    // The stranded refund is absorbed into THIS event so later decreases
    // stop netting it.
    expect(vi.mocked(recordEditRefund)).toHaveBeenCalledWith("edit-42-a2", "RF_OLD");
    expect(result.refundIds).toEqual(expect.arrayContaining(["RF_OLD", "RF2"]));
  });
});

describe("executeEditCascade — day-of refund leg (post-day-of flow)", () => {
  const DAYOF_STEPS: EditStep[] = [
    { kind: "audit_start", fatal: true },
    { kind: "refund_dayof_payment", fatal: true, amountCents: 1605 },
    { kind: "neon_commit", fatal: true },
  ];
  const ROW_PAID = { ...ROW, dayofPaymentId: "PAY_DAYOF" };
  /** A leg whose lines actually shrank — required for an itemized return. */
  const withReturn = (over: Partial<EditPlan> = {}) => {
    const p = mkPlan(DAYOF_STEPS, { diffCents: -1605, settlement: "card_refund", ...over });
    p.legs[0].returnedLines = [{ uid: "L2", name: "Pizza Bowl", quantity: 1 }];
    return p;
  };
  const dayofPlan = withReturn;

  beforeEach(() => {
    process.env.RESERVATION_EDIT_V2_MID_DECREASE = "true";
    vi.mocked(getBowlingReservation).mockResolvedValue(ROW_PAID as never);
    vi.mocked(createReturnOrder).mockResolvedValue({
      returnOrderId: "RET1",
      returnTotalCents: 1605,
    });
  });
  afterEach(() => {
    delete process.env.RESERVATION_EDIT_V2_MID_DECREASE;
  });

  it("requires a staff-supplied reason before any money moves", async () => {
    const code = await guardCode(() => executeEditCascade(baseReq(dayofPlan())));
    expect(code).toBe("dayof_reason_required");
    expect(vi.mocked(refundTenderPartial)).not.toHaveBeenCalled();
    expect(vi.mocked(startEditEvent)).not.toHaveBeenCalled();
  });

  it("refuses a day-of reason that reuses the deposit journal key", async () => {
    // Owner rule: "Refund: Reservation Deposit" is the portal's journal key
    // for the CASH leg. Reusing it here double-counts one economic event.
    const code = await guardCode(() =>
      executeEditCascade({
        ...baseReq(dayofPlan()),
        dayofRefundReason: "Refund: Reservation Deposit",
      }),
    );
    expect(code).toBe("dayof_reason_reserved");
    expect(vi.mocked(refundTenderPartial)).not.toHaveBeenCalled();
  });

  it("passes the staff reason through to Square, not the deposit key", async () => {
    vi.mocked(refundTenderPartial).mockResolvedValueOnce({
      refundId: "RF_DAYOF",
      refundedCents: 1605,
    });
    const result = await executeEditCascade({
      ...baseReq(dayofPlan()),
      dayofRefundReason: "Pizza returned unmade — lane 6",
    });
    expect(vi.mocked(refundTenderPartial)).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "PAY_DAYOF",
        amountCents: 1605,
        reason: "Pizza returned unmade — lane 6",
      }),
    );
    expect(result.refundIds).toContain("RF_DAYOF");
    expect(vi.mocked(recordEditRefund)).toHaveBeenCalledWith("edit-42-a1", "RF_DAYOF");
  });

  it("ITEMIZES the refund — builds a return order and attributes the refund to it", async () => {
    // Owner rule: never amount-only. A bare refund records a dollar figure and
    // nothing else, so the returned item never appears in item-level sales
    // reporting and QBO cannot categorize it.
    vi.mocked(refundTenderPartial).mockResolvedValueOnce({
      refundId: "RF_DAYOF",
      refundedCents: 1605,
    });
    await executeEditCascade({
      ...baseReq(dayofPlan()),
      dayofRefundReason: "Pizza returned unmade — lane 6",
    });
    expect(vi.mocked(createReturnOrder)).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceOrderId: "O1",
        lines: [{ uid: "L2", quantity: 1 }],
      }),
    );
    // The refund is deliberately NOT linked (returnOrderId omitted): a linked
    // refund does not credit the gift-card tender, which would strand the
    // money the deposit leg and the decrement both depend on. Probed
    // 2026-07-28 — see the executor comment.
    expect(vi.mocked(refundTenderPartial)).toHaveBeenCalledWith(
      expect.not.objectContaining({ returnOrderId: expect.anything() }),
    );
  });

  it("uses SQUARE's return total, not the planner's, as the refund amount", async () => {
    // Square computes the tax-inclusive return itself; that figure is
    // authoritative over our own tax math.
    vi.mocked(createReturnOrder).mockResolvedValue({
      returnOrderId: "RET1",
      returnTotalCents: 1610, // Square rounded tax differently
    });
    vi.mocked(refundTenderPartial).mockResolvedValueOnce({
      refundId: "RF_DAYOF",
      refundedCents: 1610,
    });
    await executeEditCascade({
      ...baseReq(dayofPlan()),
      dayofRefundReason: "Pizza returned unmade",
    });
    expect(vi.mocked(refundTenderPartial)).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1610 }),
    );
  });

  it("REFUSES to refund when no line items can be identified", async () => {
    // Rather than silently fall back to an amount-only refund.
    const plan = mkPlan(DAYOF_STEPS, { diffCents: -1605, settlement: "card_refund" });
    plan.legs[0].returnedLines = [];
    await expect(
      executeEditCascade({ ...baseReq(plan), dayofRefundReason: "Pizza returned" }),
    ).rejects.toThrow(
      /must be itemized, never issued as a bare amount|cannot identify which line/i,
    );
    expect(vi.mocked(refundTenderPartial)).not.toHaveBeenCalled();
  });

  it("nets a prior attempt's day-of refund instead of refunding twice", async () => {
    // The bug this closes: refundTenderPartial clamps to the PAYMENT's
    // un-refunded remainder (still large after a partial), so a retry on a
    // fresh idempotency namespace would refund the same items again.
    vi.mocked(refundedCentsForPayment).mockResolvedValueOnce({
      cents: 1605,
      refundIds: ["RF_PRIOR"],
    });
    const result = await executeEditCascade({
      ...baseReq(dayofPlan()),
      dayofRefundReason: "Pizza returned unmade — lane 6",
    });
    expect(vi.mocked(refundTenderPartial)).not.toHaveBeenCalled();
    // The prior refund is absorbed into THIS event so it stays accounted for.
    expect(vi.mocked(recordEditRefund)).toHaveBeenCalledWith("edit-42-a1", "RF_PRIOR");
    expect(result.refundIds).toContain("RF_PRIOR");
  });

  it("refunds only the un-netted remainder when a prior attempt partly paid out", async () => {
    vi.mocked(refundedCentsForPayment).mockResolvedValueOnce({
      cents: 605,
      refundIds: ["RF_PRIOR"],
    });
    vi.mocked(refundTenderPartial).mockResolvedValueOnce({
      refundId: "RF_REST",
      refundedCents: 1000,
    });
    await executeEditCascade({
      ...baseReq(dayofPlan()),
      dayofRefundReason: "Pizza returned unmade — lane 6",
    });
    expect(vi.mocked(refundTenderPartial)).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1000 }),
    );
  });
});

describe("executeEditCascade — async gift-card credit (wait_gc_credit)", () => {
  // The 2026-07-27 live finding: the refund credits the internal gift card
  // ASYNCHRONOUSLY. Decrementing before it lands reads a stale $0 balance,
  // no-ops while burning its key, and leaves the refunded value spendable —
  // silent double value.
  const WAIT_STEPS: EditStep[] = [
    { kind: "audit_start", fatal: true },
    { kind: "refund_dayof_payment", fatal: true, amountCents: 1605 },
    { kind: "refund_tender", fatal: true, amountCents: 1605 },
    { kind: "wait_gc_credit", fatal: true, target: "GC1" },
    { kind: "adjust_gift_card_down", fatal: true, target: "GC1", amountCents: 1605 },
    { kind: "neon_commit", fatal: true },
  ];
  const ROW_PAID = { ...ROW, dayofPaymentId: "PAY_DAYOF" };
  const waitPlan = (over: Partial<EditPlan> = {}) => {
    const p = mkPlan(WAIT_STEPS, { diffCents: -1605, settlement: "card_refund", ...over });
    // Itemized refunds need identifiable returned lines.
    p.legs[0].returnedLines = [{ uid: "L2", name: "Pizza Bowl", quantity: 1 }];
    return p;
  };
  const req = () => ({
    ...baseReq(waitPlan()),
    dayofRefundReason: "Lane malfunction — comped 2 games",
  });

  beforeEach(() => {
    process.env.RESERVATION_EDIT_V2_MID_DECREASE = "true";
    vi.mocked(getBowlingReservation).mockResolvedValue(ROW_PAID as never);
    depositFacts([{ paymentId: "PAY_DEP", amountCents: 20000 }]);
    vi.mocked(fetchPaymentFacts).mockResolvedValue({
      id: "PAY_DEP",
      status: "COMPLETED",
      amountCents: 20000,
      refundedCents: 0,
      sourceType: "CARD",
    } as never);
    vi.mocked(refundTenderPartial).mockResolvedValue({ refundId: "RF_X", refundedCents: 1605 });
    vi.mocked(adjustGiftCardDown).mockResolvedValue(1605);
    // Defaults per test — mockResolvedValue survives clearAllMocks.
    vi.mocked(waitForRefundCredit).mockResolvedValue({ settled: true, status: "COMPLETED" });
  });
  afterEach(() => {
    delete process.env.RESERVATION_EDIT_V2_MID_DECREASE;
  });

  it("waits for the credit BEFORE decrementing the gift card", async () => {
    const order: string[] = [];
    vi.mocked(waitForRefundCredit).mockImplementation(async () => {
      order.push("wait");
      return { settled: true, status: "COMPLETED" };
    });
    vi.mocked(adjustGiftCardDown).mockImplementation(async () => {
      order.push("decrement");
      return 1605;
    });

    const result = await executeEditCascade(req());
    expect(result.state).toBe("completed");
    expect(order).toEqual(["wait", "decrement"]);
  });

  it("parks WITHOUT decrementing when the credit has not settled", async () => {
    vi.mocked(waitForRefundCredit).mockResolvedValue({ settled: false, status: "PENDING" });

    await expect(executeEditCascade(req())).rejects.toThrow(/has not credited the gift card/i);
    expect(vi.mocked(adjustGiftCardDown)).not.toHaveBeenCalled();
    // Money that DID move is recorded, so a resume can finish the job.
    expect(vi.mocked(recordEditRefund)).toHaveBeenCalled();
    expect(vi.mocked(finishEditEvent)).toHaveBeenCalledWith(
      "edit-42-a1",
      expect.objectContaining({ state: "failed" }),
    );
  });

  it("treats a short decrement as fatal, never a green step", async () => {
    // adjustGiftCardDown returns 0 when the balance is still stale.
    vi.mocked(adjustGiftCardDown).mockResolvedValue(0);
    await expect(executeEditCascade(req())).rejects.toThrow(/decremented 0¢ of 1605¢/);
  });

  it("refuses to decrement at all when gift-card facts are unavailable", async () => {
    // The planner only WARNS and drops the step when the card is unreadable —
    // for a post-payment refund that is a silent double payout.
    const plan = waitPlan({ giftCard: null });
    await expect(
      executeEditCascade({ ...baseReq(plan), dayofRefundReason: "Lane malfunction" }),
    ).rejects.toThrow(/gift card facts unavailable/i);
  });
});
