/**
 * buildCancelPlan over the five production reservation shapes: plain bowling,
 * race, bowling+attraction-add-ons, VIP combo pair, and a mixed
 * race+attraction cart. DB modules are mocked; Square reads go through a
 * URL-routed fetch mock (pattern from lib/square-gift-card-rewards.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BowlingReservation } from "@/lib/bowling-db";
import { mkRes } from "./guards.test";
import { CancelGuardError, type CancelRequest } from "./types";

vi.mock("@/lib/bowling-db", () => ({
  getBowlingReservation: vi.fn(),
  listCancelGroupReservations: vi.fn(),
}));
vi.mock("@/lib/reservation-cancel-log", () => ({
  nextCancelAttempt: vi.fn(async () => 1),
}));
vi.mock("@/lib/reservation-edit-log", () => ({
  listEditEventsByAnchors: vi.fn(async () => []),
}));

import { getBowlingReservation, listCancelGroupReservations } from "@/lib/bowling-db";
import { nextCancelAttempt } from "@/lib/reservation-cancel-log";
import { listEditEventsByAnchors } from "@/lib/reservation-edit-log";
import { buildCancelPlan } from "./plan";

// ── Square fetch mock ────────────────────────────────────────────────────────

interface SquareWorld {
  giftCards: Record<string, { gan: string; state: string; balance: number; locationId?: string }>;
  orders: Record<
    string,
    {
      state: string;
      version?: number;
      locationId?: string;
      total?: number;
      netDue?: number;
      tenders?: Array<{ paymentId: string; amount: number }>;
    }
  >;
  payments: Record<string, { amount: number; refunded: number; status?: string }>;
}

function mockSquare(world: SquareWorld) {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    let m = url.match(/\/v2\/gift-cards\/activities\?gift_card_id=([^&]+)/);
    if (m) {
      const gc = world.giftCards[decodeURIComponent(m[1])];
      return json({
        gift_card_activities: gc?.locationId ? [{ location_id: gc.locationId }] : [],
      });
    }
    m = url.match(/\/v2\/gift-cards\/([^/?]+)$/);
    if (m) {
      const gc = world.giftCards[decodeURIComponent(m[1])];
      if (!gc) return json({ errors: [{ code: "NOT_FOUND" }] }, 404);
      return json({
        gift_card: {
          id: decodeURIComponent(m[1]),
          gan: gc.gan,
          state: gc.state,
          balance_money: { amount: gc.balance, currency: "USD" },
        },
      });
    }
    m = url.match(/\/v2\/orders\/([^/?]+)$/);
    if (m) {
      const o = world.orders[m[1]];
      if (!o) return json({ errors: [{ code: "NOT_FOUND" }] }, 404);
      return json({
        order: {
          id: m[1],
          state: o.state,
          version: o.version ?? 3,
          location_id: o.locationId ?? "TXBSQN0FEKQ11",
          total_money: { amount: o.total ?? 0, currency: "USD" },
          net_amount_due_money: { amount: o.netDue ?? o.total ?? 0, currency: "USD" },
          tenders: (o.tenders ?? []).map((t) => ({
            payment_id: t.paymentId,
            amount_money: { amount: t.amount, currency: "USD" },
          })),
        },
      });
    }
    m = url.match(/\/v2\/payments\/([^/?]+)$/);
    if (m) {
      const p = world.payments[m[1]];
      if (!p) return json({ errors: [{ code: "NOT_FOUND" }] }, 404);
      return json({
        payment: {
          id: m[1],
          status: p.status ?? "COMPLETED",
          amount_money: { amount: p.amount, currency: "USD" },
          refunded_money: { amount: p.refunded, currency: "USD" },
        },
      });
    }
    throw new Error(`unmocked Square call: ${url}`);
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FUTURE_HEAT = "2027-01-05T14:00:00"; // far future — never trips the cutoff
const FUTURE_BOOKED_AT = "2027-01-05T19:00:00.000Z";

function bowlingLeg(over: Partial<BowlingReservation> = {}): BowlingReservation {
  return mkRes({
    id: 200,
    productKind: "open",
    bookedAt: FUTURE_BOOKED_AT,
    qamfReservationId: "Q-123",
    squareDepositOrderId: "dep_1",
    squareDepositPaymentId: "pay_1",
    squareDayofOrderId: "day_bowl",
    squareGiftCardId: "gftc:internal",
    squareGiftCardGan: "WEBHPFM12345678",
    depositCents: 6710,
    totalCents: 6710,
    ...over,
  });
}

function raceLeg(over: Partial<BowlingReservation> = {}): BowlingReservation {
  return mkRes({
    id: 300,
    productKind: "race",
    centerCode: "fort-myers",
    bookedAt: "2026-07-01T00:00:00.000Z",
    bmiBillId: "63000000004093398",
    bmiReservationNumber: "W46405",
    squareDepositOrderId: "dep_1",
    squareDepositPaymentId: "pay_1",
    squareDayofOrderId: "day_race",
    squareGiftCardId: "gftc:internal",
    bookingMetadata: { heats: [{ heatId: FUTURE_HEAT }] },
    depositCents: 14058,
    totalCents: 14058,
    ...over,
  });
}

function worldFor(opts: {
  balance?: number;
  tenders?: Array<{ paymentId: string; amount: number }>;
  refunded?: Record<string, number>;
  orders?: SquareWorld["orders"];
  gcState?: string;
}): SquareWorld {
  const tenders = opts.tenders ?? [{ paymentId: "pay_1", amount: opts.balance ?? 6710 }];
  const payments: SquareWorld["payments"] = {};
  for (const t of tenders) {
    payments[t.paymentId] = { amount: t.amount, refunded: opts.refunded?.[t.paymentId] ?? 0 };
  }
  return {
    giftCards: {
      "gftc:internal": {
        gan: "WEBHPFM12345678",
        state: opts.gcState ?? "ACTIVE",
        balance: opts.balance ?? 6710,
        locationId: "TXBSQN0FEKQ11",
      },
    },
    orders: {
      dep_1: {
        state: "COMPLETED",
        tenders,
        total: tenders.reduce((s, t) => s + t.amount, 0),
        netDue: 0,
      },
      ...(opts.orders ?? {}),
    },
    payments,
  };
}

function setGroup(legs: BowlingReservation[]) {
  vi.mocked(getBowlingReservation).mockResolvedValue({ ...legs[0], lines: [] } as Awaited<
    ReturnType<typeof getBowlingReservation>
  >);
  vi.mocked(listCancelGroupReservations).mockResolvedValue(legs);
}

function req(over: Partial<CancelRequest> = {}): CancelRequest {
  return { neonId: 200, outcome: "refund", actor: "admin", dryRun: true, ...over };
}

async function expectGuard(p: Promise<unknown>, codeWanted: string) {
  try {
    await p;
  } catch (e) {
    if (e instanceof CancelGuardError) {
      expect(e.code).toBe(codeWanted);
      return;
    }
    throw e;
  }
  throw new Error(`expected CancelGuardError ${codeWanted}, got no throw`);
}

const kinds = (plan: { steps: Array<{ kind: string }> }) => plan.steps.map((s) => s.kind);

beforeEach(() => {
  vi.mocked(nextCancelAttempt).mockResolvedValue(1);
  // plan.ts reads this ledger twice per build (edit-payment folding, then the
  // store-credit ownership check) — a per-test default, not a -Once.
  vi.mocked(listEditEventsByAnchors).mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── Shapes ───────────────────────────────────────────────────────────────────

describe("plain bowling — admin refund", () => {
  it("plans refund → mark → order cancel → drain → deactivate → QAMF", async () => {
    setGroup([bowlingLeg()]);
    mockSquare(worldFor({ balance: 6710, orders: { day_bowl: { state: "OPEN", tenders: [] } } }));
    const r = await buildCancelPlan(req());
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.outcome).toBe("refund");
    expect(r.plan.amountCents).toBe(6710);
    expect(r.plan.isCombo).toBe(false);
    expect(r.plan.cascadeId).toBe("cxl-200-a1");
    expect(kinds(r.plan)).toEqual([
      "refund_tender",
      "mark_cancelled",
      "cancel_dayof_order",
      "drain_internal_gc",
      "deactivate_internal_gc",
      "delete_qamf",
    ]);
  });

  it("multi-tender deposits refund per tender", async () => {
    setGroup([bowlingLeg()]);
    mockSquare(
      worldFor({
        balance: 10000,
        tenders: [
          { paymentId: "pay_1", amount: 6000 },
          { paymentId: "pay_2", amount: 4000 },
        ],
        orders: { day_bowl: { state: "OPEN", tenders: [] } },
      }),
    );
    const r = await buildCancelPlan(req());
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.steps.filter((s) => s.kind === "refund_tender")).toHaveLength(2);
    expect(r.plan.amountCents).toBe(10000);
  });
});

describe("store credit issued by an EDIT is not the cancel's store credit", () => {
  it("refuses rather than crediting only the edit's amount and stranding the deposit", async () => {
    // Both paths write the same store_credit_* columns. Without the check the
    // planner would report the item refund's small cents as the cancel amount.
    setGroup([
      bowlingLeg({
        storeCreditGiftCardId: "gftc:edit_sc",
        storeCreditGiftCardGan: "7788990011223344",
        storeCreditCents: 1605,
        storeCreditState: "issued",
      }),
    ]);
    mockSquare(worldFor({ balance: 6710, orders: { day_bowl: { state: "OPEN", tenders: [] } } }));
    vi.mocked(listEditEventsByAnchors).mockResolvedValue([
      { state: "completed", storeCreditGiftCardId: "gftc:edit_sc", paymentIds: [], refundIds: [] },
    ] as never);

    await expectGuard(
      buildCancelPlan(req({ neonId: 200, outcome: "store_credit" })),
      "amount_mismatch",
    );
  });

  it("a cancel-issued card is still reused, not re-minted", async () => {
    setGroup([
      bowlingLeg({
        storeCreditGiftCardId: "gftc:cancel_sc",
        storeCreditGiftCardGan: "7788990011223344",
        storeCreditCents: 6710,
        storeCreditState: "issued",
      }),
    ]);
    mockSquare(worldFor({ balance: 6710, orders: { day_bowl: { state: "OPEN", tenders: [] } } }));
    // No edit event owns this card → the existing reuse path applies.
    vi.mocked(listEditEventsByAnchors).mockResolvedValue([]);

    const r = await buildCancelPlan(req({ neonId: 200, outcome: "store_credit" }));
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.amountCents).toBe(6710);
    expect(r.plan.existingStoreCredit?.giftCardId).toBe("gftc:cancel_sc");
  });
});

describe("race — customer store-credit", () => {
  it("plans issuance (which drains internally) + BMI project cancel, no QAMF, no separate drain", async () => {
    setGroup([raceLeg()]);
    mockSquare(worldFor({ balance: 14058, orders: { day_race: { state: "OPEN", tenders: [] } } }));
    const r = await buildCancelPlan(
      req({ neonId: 300, outcome: "store_credit", actor: "customer" }),
    );
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.outcome).toBe("store_credit");
    expect(r.plan.amountCents).toBe(14058);
    expect(kinds(r.plan)).toEqual([
      "issue_store_credit",
      "mark_cancelled",
      "cancel_dayof_order",
      "deactivate_internal_gc",
      "cancel_bmi_project",
    ]);
    const bmi = r.plan.steps.find((s) => s.kind === "cancel_bmi_project")!;
    expect(bmi.target).toBe("63000000004093398"); // raw string, full precision
  });

  it("customer refund on a race is blocked (staff-only)", async () => {
    setGroup([raceLeg()]);
    mockSquare(worldFor({ balance: 14058, orders: { day_race: { state: "OPEN", tenders: [] } } }));
    await expectGuard(
      buildCancelPlan(req({ neonId: 300, outcome: "refund", actor: "customer" })),
      "refund_requires_admin",
    );
  });

  it("customer cutoff uses the heat time, not booked_at", async () => {
    const soon = raceLeg({
      bookingMetadata: { heats: [{ heatId: "2020-01-01T00:10:00" }] }, // long past
    });
    setGroup([soon]);
    mockSquare(worldFor({ balance: 14058, orders: { day_race: { state: "OPEN", tenders: [] } } }));
    await expectGuard(
      buildCancelPlan(req({ neonId: 300, outcome: "store_credit", actor: "customer" })),
      "within_1_hour",
    );
  });
});

describe("bowling with attraction add-ons", () => {
  it("includes the BMI add-on cancel step", async () => {
    setGroup([
      bowlingLeg({
        attractionBookings: [
          {
            slug: "gel-blaster",
            name: "Gel Blaster",
            bmiOrderId: "63000000004093111",
            bmiBillLineId: null,
            squareCatalogObjectId: null,
            quantity: 2,
            totalPriceDollars: 24,
            timeSlot: "2027-01-05T15:00:00",
            timeLabel: "3:00 PM",
          },
        ],
      }),
    ]);
    mockSquare(worldFor({ balance: 6710, orders: { day_bowl: { state: "OPEN", tenders: [] } } }));
    const r = await buildCancelPlan(req());
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(kinds(r.plan)).toContain("cancel_bmi_addons");
  });
});

describe("VIP combo (race + bowling legs, one deposit)", () => {
  const combo = () => [
    raceLeg({ id: 301, comboSpecialId: "race-bowl" }),
    bowlingLeg({ id: 201, comboSpecialId: "race-bowl", bookedAt: FUTURE_BOOKED_AT }),
  ];
  const comboWorld = () =>
    worldFor({
      balance: 20768,
      tenders: [{ paymentId: "pay_1", amount: 20768 }],
      orders: {
        day_race: { state: "OPEN", tenders: [] },
        day_bowl: { state: "OPEN", tenders: [] },
      },
    });

  it("cancels BOTH legs: one refund, two order cancels, QAMF + BMI", async () => {
    setGroup(combo());
    mockSquare(comboWorld());
    const r = await buildCancelPlan(req({ neonId: 301 }));
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.isCombo).toBe(true);
    expect(r.plan.legIds).toEqual([301, 201]);
    expect(r.plan.steps.filter((s) => s.kind === "refund_tender")).toHaveLength(1);
    expect(r.plan.steps.filter((s) => s.kind === "mark_cancelled")).toHaveLength(2);
    expect(r.plan.steps.filter((s) => s.kind === "cancel_dayof_order")).toHaveLength(2);
    expect(kinds(r.plan)).toContain("delete_qamf");
    expect(kinds(r.plan)).toContain("cancel_bmi_project");
  });

  it("is staff-only for customers", async () => {
    setGroup(combo());
    mockSquare(comboWorld());
    await expectGuard(
      buildCancelPlan(req({ neonId: 301, outcome: "store_credit", actor: "customer" })),
      "combo_requires_admin",
    );
  });

  it("repairs a legacy partial cancel (bowling leg already cancelled)", async () => {
    const legs = combo();
    legs[1].status = "cancelled";
    setGroup(legs);
    mockSquare(comboWorld());
    const r = await buildCancelPlan(req({ neonId: 301 }));
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.warnings.join(" ")).toMatch(/already cancelled/);
    // only the race leg gets marked, but both day-of orders + the BMI project are handled
    expect(r.plan.steps.filter((s) => s.kind === "mark_cancelled").map((s) => s.legId)).toEqual([
      301,
    ]);
    expect(r.plan.steps.filter((s) => s.kind === "cancel_dayof_order")).toHaveLength(2);
  });
});

describe("mixed race+attraction cart (one bill, not a combo)", () => {
  it("dedupes the BMI project cancel by bill", async () => {
    const legs = [
      raceLeg({ id: 310 }),
      raceLeg({
        id: 311,
        productKind: "attraction",
        squareDayofOrderId: "day_race", // combined cart shares the day-of order
        bookingMetadata: { attractions: [{ slot: FUTURE_HEAT, name: "Gel Blaster" }] },
      }),
    ];
    setGroup(legs);
    mockSquare(worldFor({ balance: 14058, orders: { day_race: { state: "OPEN", tenders: [] } } }));
    const r = await buildCancelPlan(req({ neonId: 310 }));
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.isCombo).toBe(false);
    expect(r.plan.steps.filter((s) => s.kind === "cancel_bmi_project")).toHaveLength(1);
    expect(r.plan.steps.filter((s) => s.kind === "mark_cancelled")).toHaveLength(2);
    expect(r.plan.steps.filter((s) => s.kind === "cancel_dayof_order")).toHaveLength(1);
  });
});

// ── Guards at the plan level ─────────────────────────────────────────────────

describe("plan-level guards", () => {
  it("short-circuits when the whole group is already cancelled", async () => {
    setGroup([bowlingLeg({ status: "cancelled" })]);
    const r = await buildCancelPlan(req());
    expect(r.kind).toBe("already_cancelled");
  });

  it("refuses when any day-of order is tendered", async () => {
    setGroup([bowlingLeg()]);
    mockSquare(
      worldFor({
        balance: 6710,
        orders: { day_bowl: { state: "OPEN", tenders: [{ paymentId: "pay_gc", amount: 6710 }] } },
      }),
    );
    await expectGuard(buildCancelPlan(req()), "dayof_order_tendered");
  });

  it("zero rows coerce to outcome 'none' on refund, and reject store_credit", async () => {
    const free = mkRes({
      id: 400,
      productKind: "kbf",
      bookedAt: FUTURE_BOOKED_AT,
      qamfReservationId: "Q-9",
    });
    setGroup([free]);
    const r = await buildCancelPlan(req({ neonId: 400, outcome: "refund" }));
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.outcome).toBe("none");
    expect(r.plan.amountCents).toBe(0);
    expect(kinds(r.plan)).toEqual(["mark_cancelled", "delete_qamf"]);

    await expectGuard(
      buildCancelPlan(req({ neonId: 400, outcome: "store_credit" })),
      "nothing_to_credit",
    );
  });

  it("charged-but-no-gift-card rows are blocked for manual handling", async () => {
    setGroup([bowlingLeg({ squareGiftCardId: undefined })]);
    await expectGuard(buildCancelPlan(req()), "gift_card_unavailable");
  });

  it("store_credit after a prior refund is blocked (double-pay)", async () => {
    setGroup([bowlingLeg()]);
    mockSquare(
      worldFor({
        balance: 6710,
        refunded: { pay_1: 6710 },
        orders: { day_bowl: { state: "OPEN", tenders: [] } },
      }),
    );
    await expectGuard(buildCancelPlan(req({ outcome: "store_credit" })), "amount_mismatch");
  });

  it("refund resume: everything already refunded → no refund steps, still tears down", async () => {
    setGroup([bowlingLeg()]);
    mockSquare(
      worldFor({
        balance: 6710, // crash happened before the drain
        refunded: { pay_1: 6710 },
        orders: { day_bowl: { state: "OPEN", tenders: [] } },
      }),
    );
    const r = await buildCancelPlan(req());
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.steps.filter((s) => s.kind === "refund_tender")).toHaveLength(0);
    expect(kinds(r.plan)).toContain("drain_internal_gc");
    expect(r.plan.warnings.join(" ")).toMatch(/already fully refunded/);
  });

  it("store-credit resume reuses the persisted card instead of re-minting", async () => {
    setGroup([
      bowlingLeg({
        storeCreditGiftCardId: "gftc:store",
        storeCreditGiftCardGan: "7783320012345678",
        storeCreditCents: 6710,
        storeCreditState: "issued",
      }),
    ]);
    mockSquare(
      worldFor({
        balance: 0,
        gcState: "ACTIVE",
        orders: { day_bowl: { state: "OPEN", tenders: [] } },
      }),
    );
    const r = await buildCancelPlan(req({ outcome: "store_credit" }));
    if (r.kind !== "plan") throw new Error("expected plan");
    expect(r.plan.existingStoreCredit?.gan).toBe("7783320012345678");
    expect(kinds(r.plan)).not.toContain("issue_store_credit");
    expect(r.plan.amountCents).toBe(6710);
  });

  it("guard order: a tendered day-of order beats the cutoff for customers? No — cutoff first", async () => {
    const soon = raceLeg({ bookingMetadata: { heats: [{ heatId: "2020-01-01T00:10:00" }] } });
    setGroup([soon]);
    // No Square mock needed — the cutoff throws before any fetch.
    await expectGuard(
      buildCancelPlan(req({ neonId: 300, outcome: "store_credit", actor: "customer" })),
      "within_1_hour",
    );
  });
});
