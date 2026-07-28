/**
 * buildEditPlan over the core shapes: bowling PRE increase/decrease, empty
 * spec (no_changes), post-complete gating, and phase conflicts. DB modules
 * are mocked; Square reads (order GET, orders/calculate, gift card) go
 * through a URL-routed fetch mock (pattern from cancellation/plan.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BowlingReservation } from "@/lib/bowling-db";

vi.mock("@/lib/bowling-db", () => ({
  getBowlingReservation: vi.fn(),
  listCancelGroupReservations: vi.fn(),
  getBowlingSquareProducts: vi.fn(async () => PRODUCTS),
  getBowlingExperiences: vi.fn(async () => []),
  getReservationPlayersWithShoeAllowance: vi.fn(async () => ({
    players: [
      { slot: 1, name: "Ann", shoeSize: "Adult 8", bumpers: false },
      { slot: 2, name: "Bob", shoeSize: "Adult 10", bumpers: false },
    ],
    shoePairsAllowed: 2,
  })),
}));
vi.mock("@/lib/reservation-edit-log", () => ({
  hasOpenEditEvent: vi.fn(async () => false),
}));
vi.mock("~/features/card-vault", () => ({
  getChargeableCard: vi.fn(async () => ({ cardId: "ccof:CARD1", brand: "VISA", last4: "4242" })),
}));

import { getBowlingReservation, listCancelGroupReservations } from "@/lib/bowling-db";
import { buildEditPlan } from "./plan";
import { EditGuardError, type HeatMeta } from "./types";

const PRODUCTS = [
  {
    id: 1,
    centerCode: "fort-myers",
    productKind: "open",
    label: "Fun 4 All",
    squareCatalogObjectId: "CAT_OPEN",
    priceCents: 1999,
    depositPct: 100,
    sortOrder: 0,
    isActive: true,
    insertedAt: "",
  },
  {
    id: 7,
    centerCode: "fort-myers",
    productKind: "addon_shoe",
    label: "Shoe Rental",
    squareCatalogObjectId: "CAT_SHOE",
    priceCents: 500,
    depositPct: 100,
    sortOrder: 1,
    isActive: true,
    insertedAt: "",
  },
];

const TAX_RATE = 1.065;
const taxed = (subtotal: number) => Math.round(subtotal * TAX_RATE);

interface OrderWorld {
  state: string;
  tenders: Array<{ paymentId: string; amount: number }>;
  lines: Array<{ uid: string; catalogObjectId?: string; name: string; qty: number; unit: number }>;
}

const world: {
  order: OrderWorld;
  /** Deposit-order tenders + how much of each is still refundable. */
  deposit: Array<{ paymentId: string; amount: number; refunded: number }>;
} = {
  order: { state: "OPEN", tenders: [], lines: [] },
  deposit: [{ paymentId: "PAY_DEP", amount: 100_000, refunded: 0 }],
};

const orderJson = (o: OrderWorld) => {
  const subtotal = o.lines.reduce((s, l) => s + l.qty * l.unit, 0);
  return {
    order: {
      id: "O1",
      state: o.state,
      version: 3,
      location_id: "TXBSQN0FEKQ11",
      total_money: { amount: taxed(subtotal), currency: "USD" },
      net_amount_due_money: { amount: taxed(subtotal), currency: "USD" },
      tenders: o.tenders.map((t) => ({
        payment_id: t.paymentId,
        amount_money: { amount: t.amount, currency: "USD" },
      })),
      line_items: o.lines.map((l) => ({
        uid: l.uid,
        ...(l.catalogObjectId ? { catalog_object_id: l.catalogObjectId } : {}),
        name: l.name,
        quantity: String(l.qty),
        base_price_money: { amount: l.unit, currency: "USD" },
        total_money: { amount: l.qty * l.unit, currency: "USD" },
      })),
      taxes: [{ uid: "t1", catalog_object_id: "CAT_TAX", scope: "ORDER" }],
    },
  };
};

const installFetchMock = () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (/\/v2\/orders\/O1$/.test(url)) return json(orderJson(world.order));
      if (/\/v2\/orders\/DEP1$/.test(url)) {
        const total = world.deposit.reduce((s, t) => s + t.amount, 0);
        return json({
          order: {
            id: "DEP1",
            state: "COMPLETED",
            version: 1,
            location_id: "TXBSQN0FEKQ11",
            total_money: { amount: total, currency: "USD" },
            net_amount_due_money: { amount: 0, currency: "USD" },
            tenders: world.deposit.map((t) => ({
              payment_id: t.paymentId,
              amount_money: { amount: t.amount, currency: "USD" },
            })),
          },
        });
      }
      const payMatch = url.match(/\/v2\/payments\/([^/?]+)$/);
      if (payMatch) {
        const t = world.deposit.find((d) => d.paymentId === payMatch[1]);
        if (!t) return json({ errors: [{ code: "NOT_FOUND" }] }, 404);
        return json({
          payment: {
            id: t.paymentId,
            status: "COMPLETED",
            source_type: "CARD",
            amount_money: { amount: t.amount, currency: "USD" },
            refunded_money: { amount: t.refunded, currency: "USD" },
          },
        });
      }
      if (/\/v2\/orders\/calculate$/.test(url)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          order: { line_items: Array<{ quantity: string; base_price_money: { amount: number } }> };
        };
        const subtotal = body.order.line_items.reduce(
          (s, l) => s + Number(l.quantity) * l.base_price_money.amount,
          0,
        );
        return json({ order: { total_money: { amount: taxed(subtotal), currency: "USD" } } });
      }
      if (/\/v2\/gift-cards\/GC1$/.test(url)) {
        const subtotal = world.order.lines.reduce((s, l) => s + l.qty * l.unit, 0);
        return json({
          gift_card: {
            id: "GC1",
            gan: "WEBHPFM123",
            state: "ACTIVE",
            balance_money: { amount: taxed(subtotal), currency: "USD" },
          },
        });
      }
      if (/\/v2\/gift-cards\/activities\?/.test(url)) {
        return json({ gift_card_activities: [{ location_id: "TXBSQN0FEKQ11" }] });
      }
      return json({ errors: [{ code: "NOT_FOUND", detail: url }] }, 404);
    }),
  );
};

const mkRow = (over: Partial<BowlingReservation> = {}): BowlingReservation =>
  ({
    id: 42,
    centerCode: "fort-myers",
    productKind: "open",
    qamfReservationId: "Q1",
    squareDepositOrderId: "DEP1",
    squareDepositPaymentId: "PAY_DEP",
    squareDayofOrderId: "O1",
    squareGiftCardId: "GC1",
    squareGiftCardGan: "WEBHPFM123",
    depositCents: 0,
    totalCents: 0,
    status: "confirmed",
    qamfConfirmAttempts: 0,
    bookedAt: "2026-08-01T14:00:00-04:00",
    playerCount: 2,
    guestName: "Ann Guest",
    refundCents: 0,
    rewardDiscountCents: 0,
    promoSavingsCents: 0,
    storeCreditCents: 0,
    attractionBookings: [],
    squareCustomerId: "CUST1",
    bookingMetadata: {
      bowling: {
        experienceSlug: "fun-4-all",
        laneCount: 1,
        durationMultiplier: 1,
        pricingMode: "per_person",
      },
    },
    insertedAt: "",
    lines: [
      {
        id: 1,
        reservationId: 42,
        squareProductId: 1,
        label: "Fun 4 All",
        quantity: 2,
        unitPriceCents: 1999,
      },
      {
        id: 2,
        reservationId: 42,
        squareProductId: 7,
        label: "Shoe Rental",
        quantity: 2,
        unitPriceCents: 500,
      },
    ],
    ...over,
  }) as BowlingReservation & { lines: unknown[] };

beforeEach(() => {
  // Ample deposit capacity by default — gap-comp cases override it.
  world.deposit = [{ paymentId: "PAY_DEP", amount: 100_000, refunded: 0 }];
  world.order = {
    state: "OPEN",
    tenders: [],
    lines: [
      { uid: "u1", catalogObjectId: "CAT_OPEN", name: "Fun 4 All", qty: 2, unit: 1999 },
      { uid: "u2", catalogObjectId: "CAT_SHOE", name: "Shoe Rental", qty: 2, unit: 500 },
      { uid: "u3", catalogObjectId: "CAT_FEE", name: "Booking Fee", qty: 1, unit: 299 },
    ],
  };
  const row = mkRow();
  vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
  vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);
  installFetchMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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

describe("buildEditPlan — bowling PRE", () => {
  it("prices a player increase via orders/calculate and sequences the steps", async () => {
    const plan = await buildEditPlan({ neonId: 42, spec: { playerCount: 4 } });

    expect(plan.phase).toBe("pre");
    // Old: 2×1999 + 2×500 + fee 299; New: 4×1999 + 2×500 + fee 299.
    const oldSub = 2 * 1999 + 2 * 500 + 299;
    const newSub = 4 * 1999 + 2 * 500 + 299;
    expect(plan.diffCents).toBe(taxed(newSub) - taxed(oldSub));
    expect(plan.settlement).toBe("charge");
    expect(plan.chargeCard?.last4).toBe("4242");

    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toEqual([
      "audit_start",
      "charge_topup",
      "load_gift_card",
      "update_dayof_order",
      "neon_commit",
      "qamf_set_players",
      "qamf_memo",
      "notify",
    ]);

    // The primary line kept its live-order uid; the booking fee carried over.
    const leg = plan.legs[0];
    const primary = leg.newLines.find((l) => l.catalogObjectId === "CAT_OPEN")!;
    expect(primary.uid).toBe("u1");
    expect(primary.quantity).toBe(4);
    expect(leg.newLines.some((l) => l.name === "Booking Fee")).toBe(true);
  });

  it("is deterministic — two dry-runs produce the same hash", async () => {
    const a = await buildEditPlan({ neonId: 42, spec: { playerCount: 4 } });
    const b = await buildEditPlan({ neonId: 42, spec: { playerCount: 4 } });
    expect(a.planHash).toBe(b.planHash);
  });

  it("hash moves when the live order moves", async () => {
    const a = await buildEditPlan({ neonId: 42, spec: { playerCount: 4 } });
    world.order.lines[0].qty = 3; // someone else edited the order
    const b = await buildEditPlan({ neonId: 42, spec: { playerCount: 4 } });
    expect(a.planHash).not.toBe(b.planHash);
  });

  it("decrease defaults to card refund with the settlement steps", async () => {
    const plan = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    expect(plan.diffCents).toBeLessThan(0);
    expect(plan.settlement).toBe("card_refund");
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("refund_tender");
    expect(kinds).toContain("adjust_gift_card_down");
    expect(kinds.indexOf("refund_tender")).toBeLessThan(kinds.indexOf("adjust_gift_card_down"));
    expect(plan.warnings.some((w) => w.code === "settlement_defaulted")).toBe(true);
  });

  it("store-credit settlement swaps the refund step", async () => {
    const plan = await buildEditPlan({
      neonId: 42,
      spec: { playerCount: 1 },
      settlement: "store_credit",
    });
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("issue_store_credit");
    expect(kinds).not.toContain("refund_tender");
  });

  it("shoe-only edits move exactly the shoe money", async () => {
    const plan = await buildEditPlan({ neonId: 42, spec: { shoes: { 7: 4 } } });
    expect(plan.diffCents).toBe(taxed(2 * 1999 + 4 * 500 + 299) - taxed(2 * 1999 + 2 * 500 + 299));
  });

  it("refuses an empty edit (no_changes)", async () => {
    expect(await guardCode(() => buildEditPlan({ neonId: 42, spec: {} }))).toBe("no_changes");
  });
});

describe("buildEditPlan — free-form order line edits (spec.orderLines)", () => {
  beforeEach(() => {
    // A food line added outside the booking engine (day-of route / POS) —
    // exactly what a post-check-in refund is usually about.
    world.order.lines.push({ uid: "food1", name: "Pizza Bowl", qty: 1, unit: 1499 });
  });

  it("removes a food line at quantity 0 and prices the reduction", async () => {
    const before = taxed(2 * 1999 + 2 * 500 + 299 + 1499);
    const after = taxed(2 * 1999 + 2 * 500 + 299);
    const plan = await buildEditPlan({ neonId: 42, spec: { orderLines: { food1: 0 } } });

    expect(plan.diffCents).toBe(after - before);
    expect(plan.legs[0].newLines.some((l) => l.uid === "food1")).toBe(false);
    expect(plan.steps.map((s) => s.kind)).toContain("update_dayof_order");
  });

  it("reduces quantity without removing the line", async () => {
    world.order.lines.find((l) => l.uid === "food1")!.qty = 3;
    const before = taxed(2 * 1999 + 2 * 500 + 299 + 3 * 1499);
    const after = taxed(2 * 1999 + 2 * 500 + 299 + 1 * 1499);
    const plan = await buildEditPlan({ neonId: 42, spec: { orderLines: { food1: 1 } } });

    expect(plan.diffCents).toBe(after - before);
    const line = plan.legs[0].newLines.find((l) => l.uid === "food1")!;
    expect(line.quantity).toBe(1);
    expect(line.totalCents).toBe(1499);
  });

  it("REFUSES a line the booking engine owns (money would desync from the booking)", async () => {
    // u2 is the shoe line — it must move through spec.shoes so the roster,
    // QAMF, and the money stay in step.
    expect(
      await guardCode(() => buildEditPlan({ neonId: 42, spec: { orderLines: { u2: 0 } } })),
    ).toBe("pricing_unresolvable");
  });

  it("REFUSES a uid that is no longer on the live order (plan_stale)", async () => {
    expect(
      await guardCode(() => buildEditPlan({ neonId: 42, spec: { orderLines: { ghost: 0 } } })),
    ).toBe("plan_stale");
  });

  it("REFUSES a negative or fractional quantity", async () => {
    expect(
      await guardCode(() => buildEditPlan({ neonId: 42, spec: { orderLines: { food1: -1 } } })),
    ).toBe("pricing_unresolvable");
    expect(
      await guardCode(() => buildEditPlan({ neonId: 42, spec: { orderLines: { food1: 1.5 } } })),
    ).toBe("pricing_unresolvable");
  });

  it("a spec that restates the live quantity is refused as no_changes", async () => {
    // food1 is already qty 1 — nothing to move, so the editor should not open
    // a money cascade (and burn an idempotency namespace) over it.
    expect(
      await guardCode(() => buildEditPlan({ neonId: 42, spec: { orderLines: { food1: 1 } } })),
    ).toBe("no_changes");
  });
});

describe("buildEditPlan — guest-owed vs gift-card-decrement amounts", () => {
  it("the two amounts match when the deposit can cover the whole refund", async () => {
    const plan = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    expect(plan.guestOwedCents).toBe(-plan.diffCents);
    expect(plan.gcDecrementCents).toBe(-plan.diffCents);
    expect(plan.warnings.some((w) => w.code === "gap_comp_reversal")).toBe(false);
  });

  it("caps the guest's refund at deposit capacity but still clears the whole card", async () => {
    // Lane-open auto-comped part of this order onto the internal gift card, so
    // the refund exceeds what the guest's own tenders can take back. The comp
    // share has no card destination (unlinked refunds are disabled) — it must
    // still be stripped off the card or it stays spendable.
    const plan0 = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    const owed = -plan0.diffCents;
    world.deposit = [{ paymentId: "PAY_DEP", amount: owed - 150, refunded: 0 }];

    const plan = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    expect(plan.gcDecrementCents).toBe(owed);
    expect(plan.guestOwedCents).toBe(owed - 150);
    expect(plan.warnings.some((w) => w.code === "gap_comp_reversal")).toBe(true);

    // Steps carry the right amount each: guest leg capped, card leg full.
    const refund = plan.steps.find((s) => s.kind === "refund_tender")!;
    const decrement = plan.steps.find((s) => s.kind === "adjust_gift_card_down")!;
    expect(refund.amountCents).toBe(owed - 150);
    expect(decrement.amountCents).toBe(owed);
  });

  it("refuses when the shortfall exceeds the lane-open comp allowance", async () => {
    // Beyond 200¢ this is not a comp coming back — something else moved money.
    const plan0 = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    world.deposit = [{ paymentId: "PAY_DEP", amount: -plan0.diffCents - 500, refunded: 0 }];
    expect(await guardCode(() => buildEditPlan({ neonId: 42, spec: { playerCount: 1 } }))).toBe(
      "pricing_unresolvable",
    );
  });

  it("counts already-refunded cents against capacity", async () => {
    const plan0 = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    const owed = -plan0.diffCents;
    // Tender is large, but most of it has already been refunded.
    world.deposit = [{ paymentId: "PAY_DEP", amount: 100_000, refunded: 100_000 - (owed - 100) }];

    const plan = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    expect(plan.guestOwedCents).toBe(owed - 100);
    expect(plan.gcDecrementCents).toBe(owed);
  });

  it("warns (not throws) when the deposit order cannot be read", async () => {
    const row = mkRow({ squareDepositOrderId: "MISSING" });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);

    const plan = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    expect(plan.warnings.some((w) => w.code === "deposit_capacity_unknown")).toBe(true);
    expect(plan.guestOwedCents).toBe(-plan.diffCents);
  });
});

describe("buildEditPlan — phase gates", () => {
  it("sent_at without tenders is a phase_conflict", async () => {
    const row = mkRow({ dayofOrderSentAt: "2026-08-01T13:00:00Z" });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);
    expect(await guardCode(() => buildEditPlan({ neonId: 42, spec: { playerCount: 3 } }))).toBe(
      "phase_conflict",
    );
  });

  it("post-complete requires the manager acknowledgment, then plans refund+rebuild", async () => {
    world.order.state = "COMPLETED";
    world.order.tenders = [{ paymentId: "PAY_GC", amount: 5000 }];
    const row = mkRow({ status: "completed", dayofOrderSentAt: "2026-08-01T13:00:00Z" });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);

    expect(await guardCode(() => buildEditPlan({ neonId: 42, spec: { playerCount: 3 } }))).toBe(
      "post_complete_ack_required",
    );

    const plan = await buildEditPlan({
      neonId: 42,
      spec: { playerCount: 3 },
      managerOverride: true,
    });
    expect(plan.phase).toBe("post_complete");
    expect(plan.warnings.some((w) => w.severity === "manager")).toBe(true);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("refund_dayof_order");
    expect(kinds).toContain("rebuild_dayof_order");
    expect(kinds).toContain("pay_dayof_order");
    expect(kinds).toContain("complete_dayof_order");
    expect(kinds).not.toContain("qamf_set_players"); // QAMF never touched post-complete
  });

  it("post-complete DECREASE is money-only — no rebuild, no order-id swap", async () => {
    // A frozen order's lines cannot change, so refunding an item does not need
    // a replacement order. Rebuilding would swap square_dayof_order_id (which
    // breaks the QBO race-catalog mapping), re-issue loyalty/discounts, and
    // add refund noise for no gain.
    world.order.state = "COMPLETED";
    world.order.tenders = [{ paymentId: "PAY_GC", amount: 5000 }];
    const row = mkRow({ status: "completed", dayofOrderSentAt: "2026-08-01T13:00:00Z" });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);

    const plan = await buildEditPlan({
      neonId: 42,
      spec: { playerCount: 1 },
      managerOverride: true,
    });
    expect(plan.diffCents).toBeLessThan(0);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("refund_dayof_payment");
    expect(kinds).toContain("refund_tender");
    expect(kinds).not.toContain("refund_dayof_order");
    expect(kinds).not.toContain("rebuild_dayof_order");
    expect(kinds).not.toContain("pay_dayof_order");
    // The card is reconciled instead of waited on + decremented.
    expect(kinds).toContain("reconcile_gift_card");
    expect(kinds).not.toContain("adjust_gift_card_down");
  });

  // NOTE: the whole-order-to-zero shapes (full_refund_use_cancel on MID, and
  // the post-complete no-rebuild branch) are DEFENSIVE. A bowling row cannot
  // reach newTotalCents === 0 through today's spec surface — the repricer
  // requires a primary lane line, and that line is engine-owned so
  // spec.orderLines cannot remove it. They are left in place because the
  // branch is cheap and the failure mode (an OPEN order stranded at
  // balance-due, invisible to bowling-order-complete forever) is expensive.
  // Cover them for real when a product shape can actually produce a $0 order.

  it("mid-session NEVER emits a line update — a tendered order's lines are frozen", async () => {
    // Probed 2026-07-27: Square refuses any line change on an order with
    // finalized tenders, before OR after a refund, in full or in part
    // ("LineItems cannot be modified for finalized tenders"). Emitting the
    // step would guarantee a fatal mid-cascade failure after money moved.
    world.order.tenders = [{ paymentId: "PAY_GC", amount: 5000 }];
    const row = mkRow({ dayofOrderSentAt: "2026-08-01T13:00:00Z", status: "arrived" });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);

    const plan = await buildEditPlan({ neonId: 42, spec: { playerCount: 1 } });
    expect(plan.phase).toBe("mid");
    expect(plan.diffCents).toBeLessThan(0);
    expect(plan.steps.map((s) => s.kind)).not.toContain("update_dayof_order");
    // Staff are told why the order still lists the original items.
    expect(plan.warnings.some((w) => w.code === "dayof_lines_frozen")).toBe(true);
  });

  it("mid-session (paid OPEN order) allows player edits but blocks lane changes", async () => {
    world.order.tenders = [{ paymentId: "PAY_GC", amount: 5000 }];
    const row = mkRow({ dayofOrderSentAt: "2026-08-01T13:00:00Z", status: "arrived" });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);

    const plan = await buildEditPlan({ neonId: 42, spec: { playerCount: 3 } });
    expect(plan.phase).toBe("mid");
    expect(plan.steps.map((s) => s.kind)).toContain("charge_dayof_order");

    expect(await guardCode(() => buildEditPlan({ neonId: 42, spec: { laneCount: 2 } }))).toBe(
      "lane_change_mid_session",
    );
  });

  it("cancelled rows are refused", async () => {
    const row = mkRow({ status: "cancelled" });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);
    expect(await guardCode(() => buildEditPlan({ neonId: 42, spec: { playerCount: 3 } }))).toBe(
      "cancelled",
    );
  });
});

describe("buildEditPlan — attraction quantity changes", () => {
  const withAttraction = () =>
    mkRow({
      attractionBookings: [
        {
          slug: "laser-tag",
          name: "Laser Tag",
          bmiOrderId: "90000000000000001",
          bmiBillLineId: "70000000000000007",
          squareCatalogObjectId: "CAT_LT",
          quantity: 2,
          totalPriceDollars: 24,
          timeSlot: "2026-08-01T15:00:00",
          timeLabel: "3:00 PM",
        },
      ],
    });

  beforeEach(() => {
    world.order.lines.push({
      uid: "u9",
      catalogObjectId: "CAT_LT",
      name: "Laser Tag",
      qty: 2,
      unit: 1200,
    });
    const row = withAttraction();
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);
  });

  it("prices a qty increase and orders the BMI replace before money", async () => {
    const plan = await buildEditPlan({
      neonId: 42,
      spec: { attractions: [{ index: 0, quantity: 3 }] },
    });
    const base = 2 * 1999 + 2 * 500 + 299;
    expect(plan.diffCents).toBe(taxed(base + 3 * 1200) - taxed(base + 2 * 1200));
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("bmi_attractions");
    expect(kinds.indexOf("bmi_attractions")).toBeLessThan(kinds.indexOf("charge_topup"));
    expect(plan.legs[0].attractionChanges).toEqual([
      expect.objectContaining({ index: 0, newQuantity: 3, oldQuantity: 2, unitPriceCents: 1200 }),
    ]);
    expect(plan.current.attractions[0]).toMatchObject({ editable: true, quantity: 2 });
  });

  it("qty 0 removes the order line entirely", async () => {
    const plan = await buildEditPlan({
      neonId: 42,
      spec: { attractions: [{ index: 0, quantity: 0 }] },
    });
    expect(plan.legs[0].newLines.some((l) => l.catalogObjectId === "CAT_LT")).toBe(false);
    expect(plan.diffCents).toBeLessThan(0);
  });

  it("refuses add-ons without BMI line ids", async () => {
    const row = mkRow({
      attractionBookings: [
        {
          slug: "laser-tag",
          name: "Laser Tag",
          bmiOrderId: null,
          bmiBillLineId: null,
          squareCatalogObjectId: "CAT_LT",
          quantity: 2,
          totalPriceDollars: 24,
          timeSlot: "2026-08-01T15:00:00",
          timeLabel: "3:00 PM",
        },
      ],
    });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);
    expect(
      await guardCode(() =>
        buildEditPlan({ neonId: 42, spec: { attractions: [{ index: 0, quantity: 3 }] } }),
      ),
    ).toBe("bmi_line_unavailable");
  });

  it("unknown index is plan_stale", async () => {
    expect(
      await guardCode(() =>
        buildEditPlan({ neonId: 42, spec: { attractions: [{ index: 5, quantity: 1 }] } }),
      ),
    ).toBe("plan_stale");
  });
});

describe("buildEditPlan — duration changes", () => {
  it("swaps the multiplier via the experience's duration options and plans a QAMF rebook", async () => {
    const { getBowlingExperiences } = await import("@/lib/bowling-db");
    vi.mocked(getBowlingExperiences).mockResolvedValue([
      {
        id: 1,
        slug: "lane-rental",
        label: "Lane Rental",
        kind: "hourly",
        isVip: false,
        description: null,
        sortOrder: 0,
        isActive: true,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        squareModifierListIds: [],
        insertedAt: "",
        qamfWebOfferId: 555,
        qamfOptionType: "Time",
        qamfOptionId: 71,
        items: [
          {
            id: 10,
            experienceId: 1,
            squareProductId: 1,
            label: "Lane Rental",
            priceCents: 1999,
            depositPct: 100,
            squareCatalogObjectId: "CAT_OPEN",
            quantity: 1,
            sortOrder: 0,
            productKind: "hourly",
          },
        ],
        durationOptions: [
          {
            id: 3,
            experienceId: 1,
            centerCode: "fort-myers",
            qamfOptionId: 71,
            durationMinutes: 90,
            label: "1.5 Hours",
            squareMultiplier: 1,
            sortOrder: 0,
            overrideSquareProductId: null,
            overridePriceCents: null,
            overrideDepositPct: null,
            overrideCatalogObjectId: null,
          },
          {
            id: 4,
            experienceId: 1,
            centerCode: "fort-myers",
            qamfOptionId: 72,
            durationMinutes: 120,
            label: "2 Hours",
            squareMultiplier: 2,
            sortOrder: 1,
            overrideSquareProductId: null,
            overridePriceCents: null,
            overrideDepositPct: null,
            overrideCatalogObjectId: null,
          },
        ],
      },
    ] as never);
    const row = mkRow({
      bookingMetadata: {
        bowling: {
          experienceSlug: "lane-rental",
          laneCount: 2,
          durationMultiplier: 1,
          pricingMode: "per_lane",
        },
      },
    });
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);

    const plan = await buildEditPlan({ neonId: 42, spec: { durationOptionId: 4 } });
    // Primary 2 → 4 units (2 lanes × multiplier 2).
    expect(plan.legs[0].newLines.find((l) => l.catalogObjectId === "CAT_OPEN")!.quantity).toBe(4);
    expect(plan.legs[0].newDuration).toEqual({ optionId: 4, qamfOptionId: 72, multiplier: 2 });
    expect(plan.current.durationOptions).toHaveLength(2);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("qamf_rebook");
    expect(kinds.indexOf("qamf_rebook")).toBeLessThan(kinds.indexOf("charge_topup"));
  });

  it("refuses an option the experience doesn't offer", async () => {
    expect(
      await guardCode(() => buildEditPlan({ neonId: 42, spec: { durationOptionId: 99 } })),
    ).toBe("pricing_unresolvable");
  });
});

describe("buildEditPlan — race heat removals", () => {
  const mkHeat = (over: Partial<HeatMeta> = {}): HeatMeta =>
    ({
      productId: null,
      track: "pro",
      heatId: "2026-08-01T15:00:00",
      assignedTo: null,
      bmiPersonId: null,
      racer: "Ann",
      ...over,
    }) as HeatMeta;

  const useRaceRow = (heats: HeatMeta[]) => {
    const row = mkRow({
      productKind: "race",
      bmiBillId: "80000000000000001",
      bookingMetadata: { heats },
      lines: [],
    } as never);
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);
  };

  beforeEach(() => {
    world.order.lines = [{ uid: "u1", name: "Race heat", qty: 2, unit: 2500 }];
  });

  it("refuses a legacy heat (no bmiLineId) at PLAN time, before any money step", async () => {
    useRaceRow([mkHeat(), mkHeat({ racer: "Bob" })]);
    expect(
      await guardCode(() =>
        buildEditPlan({ neonId: 42, spec: { racers: { removeHeatIndexes: [0] } } }),
      ),
    ).toBe("bmi_line_unavailable");
  });

  it("plans the removal when the heat carries its bmiLineId", async () => {
    useRaceRow([
      mkHeat({ bmiLineId: "60000000000000001" }),
      mkHeat({ racer: "Bob", bmiLineId: "60000000000000002" }),
    ]);
    const plan = await buildEditPlan({
      neonId: 42,
      spec: { racers: { removeHeatIndexes: [0] } },
    });
    expect(plan.legs[0].removedHeats).toEqual([
      { index: 0, bmiLineId: "60000000000000001", label: "Race heat" },
    ]);
    expect(plan.diffCents).toBeLessThan(0);
  });

  it("rows without a BMI bill skip the line-tracking guard", async () => {
    const row = mkRow({
      productKind: "race",
      bmiBillId: null,
      bookingMetadata: { heats: [mkHeat(), mkHeat({ racer: "Bob" })] },
      lines: [],
    } as never);
    vi.mocked(getBowlingReservation).mockResolvedValue(row as never);
    vi.mocked(listCancelGroupReservations).mockResolvedValue([row] as never);
    const plan = await buildEditPlan({
      neonId: 42,
      spec: { racers: { removeHeatIndexes: [0] } },
    });
    expect(plan.legs[0].removedHeats).toEqual([{ index: 0, bmiLineId: null, label: "Race heat" }]);
  });
});
