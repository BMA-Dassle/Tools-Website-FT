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
import { EditGuardError } from "./types";

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

const world: { order: OrderWorld } = {
  order: { state: "OPEN", tenders: [], lines: [] },
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
