/**
 * The guard list, one test per refusal.
 *
 * These guards are the only thing between a mis-click and real money, so each
 * gets its own case rather than being sampled. Every dependency is injected, so
 * none of this touches Square or Neon.
 */
import { describe, expect, it, vi } from "vitest";
import { makeDealPurchaseRow } from "~/features/web-sales/test-support";
import { dealSquareCatalogId, getDeal } from "../catalog";
import {
  DEAL_REFUND_REASON,
  buildDealRefundPlan,
  isReservedRefundReason,
  type PaymentFacts,
  type RefundPlanDeps,
} from "./refund-plan";

/**
 * The REAL catalog id, not an invented one. The plan refuses an order whose line
 * is a different product, so a made-up id here makes every case fail with
 * `order_not_this_deal` and hides whatever it was actually testing.
 */
const CATALOG_ID_LASER = dealSquareCatalogId(getDeal("laser-tag-game-card-pack")!);

/**
 * Deliberately far larger than any fixture's total, so the remainder guard only
 * fires in the one test that asks for it. A payment sized to a single pack makes
 * every multi-pack case fail with `insufficient_remainder` and hides what it was
 * actually asserting.
 */
const payment = (patch: Partial<PaymentFacts> = {}): PaymentFacts => ({
  status: "COMPLETED",
  amountCents: 1_000_000,
  refundedCents: 0,
  sourceType: "CARD",
  ...patch,
});

function deps(patch: Partial<RefundPlanDeps> = {}): RefundPlanDeps {
  return {
    spentIndexes: async () => new Set<number>(),
    fetchOrder: async () => ({
      lineItems: [{ uid: "LINE1", catalogObjectId: CATALOG_ID_LASER, quantity: "1" }],
      tenderCount: 1,
    }),
    fetchPayment: async () => payment(),
    // Stand-in for Square's calculator: the real one is exercised live.
    quotePacks: async (deal, row, packs) => Math.round((row.totalCents / row.qty) * packs),
    listRefunds: async () => [],
    refundsEnabled: () => true,
    giftCardRefundsEnabled: () => true,
    ...patch,
  };
}

const plan = (row = makeDealPurchaseRow(), d = deps(), extra = {}) =>
  buildDealRefundPlan({ row, destination: "card", unitKeys: null, deps: d, ...extra });

describe("refuses to plan", () => {
  it("a purchase that was never charged", async () => {
    const p = await plan(makeDealPurchaseRow({ status: "charge_failed" }));
    expect(p.blocked?.code).toBe("not_charged");
  });

  it("a purchase with no Square ids", async () => {
    const p = await plan(makeDealPurchaseRow({ squarePaymentId: null }));
    expect(p.blocked?.code).toBe("no_square_ids");
  });

  it("a purchase whose vouchers were never minted", async () => {
    // Refunding here leaves the reconcile cron free to mint codes for money we
    // just gave back.
    const p = await plan(makeDealPurchaseRow({ status: "charged", codes: [] }));
    expect(p.blocked?.code).toBe("not_minted");
  });

  it("a deal that has left the catalog", async () => {
    const p = await plan(makeDealPurchaseRow({ dealSlug: "retired-pack" }));
    expect(p.blocked?.code).toBe("unknown_deal");
  });

  it("a purchase whose codes disagree with its shape", async () => {
    const p = await plan(makeDealPurchaseRow({ combine: true, qty: 2, codes: ["A", "B"] }));
    expect(p.blocked?.code).toBe("codes_shape_mismatch");
  });

  it("a purchase that is already fully refunded", async () => {
    const p = await plan(
      makeDealPurchaseRow({ qty: 1 }),
      deps({
        listRefunds: async () => [
          { state: "settled", packs: 1, refundedCents: 3621, packIndexes: [0] } as never,
        ],
      }),
    );
    expect(p.blocked?.code).toBe("already_refunded");
  });

  it("a purchase with another attempt in flight", async () => {
    // Two staff refunding the same purchase at once is exactly what this is for.
    const p = await plan(
      makeDealPurchaseRow(),
      deps({
        listRefunds: async () => [
          { state: "returning", seq: 1, packs: 1, refundedCents: 0, packIndexes: [] } as never,
        ],
      }),
    );
    expect(p.blocked?.code).toBe("refund_in_progress");
  });

  it("a payment Square has not captured", async () => {
    const p = await plan(
      makeDealPurchaseRow(),
      deps({ fetchPayment: async () => payment({ status: "PENDING" }) }),
    );
    expect(p.blocked?.code).toBe("payment_not_captured");
  });

  it("a split-tender order", async () => {
    const p = await plan(
      makeDealPurchaseRow(),
      deps({
        fetchOrder: async () => ({
          lineItems: [{ uid: "LINE1", catalogObjectId: CATALOG_ID_LASER }],
          tenderCount: 2,
        }),
      }),
    );
    expect(p.blocked?.code).toBe("split_tender_unsupported");
  });

  it("an order that is not shaped like a deal pack", async () => {
    const p = await plan(
      makeDealPurchaseRow(),
      deps({
        fetchOrder: async () => ({
          lineItems: [{ uid: "A" }, { uid: "B" }],
          tenderCount: 1,
        }),
      }),
    );
    expect(p.blocked?.code).toBe("unexpected_order_shape");
  });

  it("an order whose line has no uid — never falling back to amount-only", async () => {
    // An unitemized refund records a dollar figure and nothing else: the item
    // never reaches item-level reporting and QBO cannot categorise it.
    const p = await plan(
      makeDealPurchaseRow(),
      deps({ fetchOrder: async () => ({ lineItems: [{ uid: "" }], tenderCount: 1 }) }),
    );
    expect(p.blocked?.code).toBe("no_line_uid");
  });

  it("an order selling a different product", async () => {
    const p = await plan(
      makeDealPurchaseRow(),
      deps({
        fetchOrder: async () => ({
          lineItems: [{ uid: "LINE1", catalogObjectId: "SOME_OTHER_ITEM" }],
          tenderCount: 1,
        }),
      }),
    );
    expect(p.blocked?.code).toBe("order_not_this_deal");
  });

  it("a card refund of a gift-card-funded payment", async () => {
    // Square accepts it, but the money lands on the gift card and staff would
    // tell the guest the wrong thing.
    const p = await plan(
      makeDealPurchaseRow(),
      deps({ fetchPayment: async () => payment({ sourceType: "GIFT_CARD" }) }),
    );
    expect(p.blocked?.code).toBe("gc_funded_original");
  });

  it("a refund larger than what Square says is left on the payment", async () => {
    const p = await plan(
      makeDealPurchaseRow(),
      deps({ fetchPayment: async () => payment({ amountCents: 3621, refundedCents: 3000 }) }),
    );
    expect(p.blocked?.code).toBe("insufficient_remainder");
  });

  it("an empty explicit selection", async () => {
    const p = await buildDealRefundPlan({
      row: makeDealPurchaseRow(),
      destination: "card",
      unitKeys: [],
      deps: deps(),
    });
    expect(p.blocked?.code).toBe("nothing_selected");
  });
});

describe("the plan itself", () => {
  it("defaults to every untouched pack", async () => {
    const p = await plan(makeDealPurchaseRow({ qty: 3, combine: true, codes: ["HPWAAA"], totalCents: 10863 }));
    expect(p.selectedUnitKeys).toHaveLength(3);
    expect(p.fullyUnspentPacks).toBe(3);
    expect(p.needsOverride).toBe(false);
  });

  it("excludes a partly-used pack from the default", async () => {
    const p = await plan(
      makeDealPurchaseRow({ qty: 3, combine: true, codes: ["HPWAAA"], totalCents: 10863 }),
      deps({ spentIndexes: async () => new Set([5]) }),
    );
    // Pack 1 owns legs 4-7, so it drops out and the default is the other two.
    expect(p.selectedUnitKeys).toHaveLength(2);
    expect(p.fullyUnspentPacks).toBe(2);
  });

  it("demands an override to reach past the untouched packs, and warns with numbers", async () => {
    const states = await plan(
      makeDealPurchaseRow({ qty: 2, combine: true, codes: ["HPWAAA"], totalCents: 7242 }),
      deps({ spentIndexes: async () => new Set([0]) }),
    );
    const all = states.units.map((u) => u.unitKey);
    const p = await buildDealRefundPlan({
      row: makeDealPurchaseRow({ qty: 2, combine: true, codes: ["HPWAAA"], totalCents: 7242 }),
      destination: "card",
      unitKeys: all,
      deps: deps({ spentIndexes: async () => new Set([0]) }),
    });
    expect(p.needsOverride).toBe(true);
    expect(p.spentValueIncludedCents).toBeGreaterThan(0);
    expect(p.warnings.join(" ")).toMatch(/already been partly used/);
  });

  it("clears the override flag once it is explicit", async () => {
    const row = makeDealPurchaseRow({ qty: 2, combine: true, codes: ["HPWAAA"], totalCents: 7242 });
    const d = deps({ spentIndexes: async () => new Set([0]) });
    const first = await buildDealRefundPlan({ row, destination: "card", unitKeys: null, deps: d });
    const p = await buildDealRefundPlan({
      row,
      destination: "card",
      unitKeys: first.units.map((u) => u.unitKey),
      override: true,
      deps: d,
    });
    expect(p.needsOverride).toBe(false);
  });

  it("nets prior settled refunds out of what is still refundable", async () => {
    const p = await plan(
      makeDealPurchaseRow({ qty: 3, combine: true, codes: ["HPWAAA"], totalCents: 10863 }),
      deps({
        listRefunds: async () => [
          { state: "settled", packs: 1, refundedCents: 3621, packIndexes: [0] } as never,
        ],
      }),
    );
    expect(p.refundablePacks).toBe(2);
    expect(p.refundedCents).toBe(3621);
    expect(p.units.find((u) => u.alreadyRefunded)).toBeTruthy();
  });

  it("warns that a gift-card refund cannot be itemized", async () => {
    // Probe-proven: Square drops the credit when a cross-tender refund carries
    // an order id. Staff should read that on screen, not in a script.
    const p = await buildDealRefundPlan({
      row: makeDealPurchaseRow(),
      destination: "gift_card",
      unitKeys: null,
      deps: deps(),
    });
    expect(p.warnings.join(" ")).toMatch(/cannot be itemized/);
  });

  it("hides the gift-card destination when its kill switch is off", async () => {
    const p = await plan(makeDealPurchaseRow(), deps({ giftCardRefundsEnabled: () => false }));
    expect(p.destinations).toEqual(["card"]);
  });

  it("still renders a full plan when refunds are switched off, marked blocked", async () => {
    // Finding out at the moment you click the money button is the worst time.
    const p = await plan(makeDealPurchaseRow(), deps({ refundsEnabled: () => false }));
    expect(p.blocked?.code).toBe("not_enabled");
    expect(p.units.length).toBeGreaterThan(0);
    expect(p.selectedTotalCents).toBeGreaterThan(0);
  });
});

describe("planHash", () => {
  const row = makeDealPurchaseRow({ qty: 2, combine: true, codes: ["HPWAAA"], totalCents: 7242 });

  it("is stable across two identical builds", async () => {
    const a = await plan(row);
    const b = await plan(row);
    expect(a.planHash).toBe(b.planHash);
    expect(a.planHash).toHaveLength(64);
  });

  it("CHANGES when a leg is redeemed mid-decision", async () => {
    // The reason the hash exists: a guest can scan the very code being refunded
    // between the modal opening and execute. Nothing else notices.
    const before = await plan(row);
    const after = await plan(row, deps({ spentIndexes: async () => new Set([0]) }));
    expect(after.planHash).not.toBe(before.planHash);
  });

  it("changes when the destination changes", async () => {
    const card = await plan(row);
    const gc = await buildDealRefundPlan({ row, destination: "gift_card", unitKeys: null, deps: deps() });
    expect(gc.planHash).not.toBe(card.planHash);
  });

  it("changes when someone refunds part of the payment in the Square Dashboard", async () => {
    const before = await plan(row);
    const after = await plan(row, deps({ fetchPayment: async () => payment({ refundedCents: 100 }) }));
    expect(after.planHash).not.toBe(before.planHash);
  });

  it("changes when the override flips", async () => {
    const off = await plan(row);
    const on = await buildDealRefundPlan({
      row,
      destination: "card",
      unitKeys: null,
      override: true,
      deps: deps(),
    });
    expect(on.planHash).not.toBe(off.planHash);
  });
});

describe("the Square refund reason", () => {
  it("is a pinned constant for this domain", () => {
    // Immutable once Square records it, and the accounting portal keys its
    // journal off the string.
    expect(DEAL_REFUND_REASON).toBe("Refund: Deal Pack");
  });

  it("is not another domain's journal key", () => {
    expect(DEAL_REFUND_REASON).not.toBe("Refund: Reservation Deposit");
    expect(DEAL_REFUND_REASON).not.toBe("Refund: Group Event Deposit");
  });

  it("refuses staff text that would collide with a reserved journal", () => {
    expect(isReservedRefundReason("reservation deposit refund")).toBe(true);
    expect(isReservedRefundReason("Reservation Deposit")).toBe(true);
    expect(isReservedRefundReason("Group Event Deposit")).toBe(true);
    expect(isReservedRefundReason("bought twice by mistake")).toBe(false);
  });
});

describe("dependency wiring", () => {
  it("asks Square for the tax-inclusive total rather than doing local tax maths", async () => {
    const quotePacks: RefundPlanDeps["quotePacks"] = vi.fn(async () => 7242);
    await plan(
      makeDealPurchaseRow({ qty: 2, combine: true, codes: ["HPWAAA"], totalCents: 7242 }),
      deps({ quotePacks }),
    );
    expect(vi.mocked(quotePacks)).toHaveBeenCalledOnce();
    expect(vi.mocked(quotePacks).mock.calls[0][2]).toBe(2);
  });

  it("reads the spent set once per distinct code, not once per pack", async () => {
    const spentIndexes = vi.fn(async () => new Set<number>());
    await plan(
      makeDealPurchaseRow({ qty: 4, combine: true, codes: ["HPWAAA"], totalCents: 14484 }),
      deps({ spentIndexes }),
    );
    expect(spentIndexes).toHaveBeenCalledTimes(1);
  });
});
