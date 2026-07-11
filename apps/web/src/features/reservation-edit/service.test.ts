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
  markEditPendingPayment: vi.fn(async () => {}),
  listEditEventsByAnchors: vi.fn(async () => []),
  getLatestEditEvent: vi.fn(async () => null),
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
  adjustGiftCardDown: vi.fn(async () => 500),
  updateDayofOrderLines: vi.fn(async () => ({ totalCents: 9999, version: 4 })),
  chargeDayofOrder: vi.fn(async () => ({ paymentId: "PAY_MID" })),
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
  markEditPendingPayment,
  recordEditPayment,
  startEditEvent,
} from "@/lib/reservation-edit-log";
import { loadGiftCard } from "@/lib/square-gift-card";
import { fetchOrderFacts } from "~/features/cancellation/square-actions";
import {
  createEditTopupOrderAndCharge,
  refundTenderPartial,
  updateDayofOrderLines,
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
      removedHeats: null,
      raceAdds: null,
      attractionChanges: null,
    },
  ],
  diffCents: 4999,
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

describe("executeEditCascade — PRE decrease", () => {
  it("refunds before decrementing the gift card and records refund ids", async () => {
    vi.mocked(fetchOrderFacts).mockImplementation(async (orderId: string) =>
      orderId === "DEP1"
        ? ({
            id: "DEP1",
            state: "COMPLETED",
            version: 1,
            locationId: "TXBSQN0FEKQ11",
            tenderCount: 1,
            netDueCents: 0,
            totalCents: 5000,
            tenders: [{ paymentId: "PAY_DEP", amountCents: 5000 }],
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
    vi.mocked(refundTenderPartial).mockResolvedValueOnce({ refundId: "RF1", refundedCents: 500 });

    const steps: EditStep[] = [
      { kind: "audit_start", fatal: true },
      { kind: "refund_tender", fatal: true, amountCents: 500 },
      { kind: "adjust_gift_card_down", fatal: true, target: "GC1", amountCents: 500 },
      { kind: "update_dayof_order", fatal: true, target: "O1", amountCents: -500 },
      { kind: "neon_commit", fatal: true },
      { kind: "notify", fatal: false },
    ];
    const result = await executeEditCascade(
      baseReq(mkPlan(steps, { diffCents: -500, settlement: "card_refund" })),
    );
    expect(result.refundIds).toEqual(["RF1"]);
    expect(vi.mocked(refundTenderPartial)).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "PAY_DEP", amountCents: 500 }),
    );
  });
});
