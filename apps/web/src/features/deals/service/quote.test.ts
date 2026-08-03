import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the imports, so the spy has to be created inside
// vi.hoisted — a plain top-level const is not initialised yet when the factory runs.
const { squareFetch } = vi.hoisted(() => ({ squareFetch: vi.fn() }));
vi.mock("~/features/account/data/square-client", () => ({
  squareFetch,
  squareErrorDetail: (d: unknown) =>
    (d as { errors?: { detail?: string }[] })?.errors?.[0]?.detail ?? "Square error",
}));

import {
  assertQuoteMatches,
  buildDealOrder,
  createDealOrder,
  DEAL_SQUARE_LOCATION,
  DealQuoteError,
  quoteDeal,
} from "./quote";
import { getDeal } from "../catalog";

/** A deal with a Square catalog id filled in — the registry ships them null
 *  until the owner supplies real ones, so every pricing test needs one. */
function sellable(slug: string, catalogId = "TESTCATALOGID") {
  return { ...getDeal(slug)!, squareCatalogId: catalogId };
}

beforeEach(() => {
  squareFetch.mockReset();
});

describe("buildDealOrder", () => {
  it("is ONE catalog line, quantity = packs, price overridden from the registry", () => {
    const order = buildDealOrder({ deal: sellable("laser-tag-game-card-pack"), location: "headpinz", qty: 3 });
    expect(order.location_id).toBe(DEAL_SQUARE_LOCATION.headpinz);
    const lines = order.line_items as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      quantity: "3",
      base_price_money: { amount: 3400, currency: "USD" },
      catalog_object_id: "TESTCATALOGID",
      name: "Laser Tag + Game Card Pack",
    });
  });

  it("taxes the WHOLE line — no split between the attraction and card halves", () => {
    const order = buildDealOrder({ deal: sellable("gel-blaster-game-card-pack"), location: "headpinz", qty: 1 });
    const lines = order.line_items as Record<string, unknown>[];
    expect(lines[0].applied_taxes).toEqual([{ tax_uid: "line-tax" }]);
    // Lee County object, LINE_ITEM scope.
    expect(order.taxes).toEqual([
      { uid: "line-tax", catalog_object_id: "UBPQTR3W6ZKVRYFC7DXN2SJN", scope: "LINE_ITEM" },
    ]);
  });

  it("uses the Collier County tax object for Naples", () => {
    const order = buildDealOrder({ deal: sellable("laser-tag-game-card-pack"), location: "naples", qty: 1 });
    expect(order.location_id).toBe(DEAL_SQUARE_LOCATION.naples);
    expect(order.taxes).toEqual([
      { uid: "line-tax", catalog_object_id: "BQNVIEEZQO2PX2FI72U6FEC4", scope: "LINE_ITEM" },
    ]);
  });

  it("refuses to build an order for a deal with no Square catalog id", () => {
    // An ad-hoc line would charge fine and be invisible in QBO forever — there is
    // no way to attach categorisation to a captured payment after the fact. The
    // shipped deals all have ids now, so this guards the NEXT deal added to the
    // registry before its Square item exists.
    const deal = { ...getDeal("laser-tag-game-card-pack")!, squareCatalogId: null };
    expect(() => buildDealOrder({ deal, location: "headpinz", qty: 1 })).toThrow(DealQuoteError);
    expect(() => buildDealOrder({ deal, location: "headpinz", qty: 1 })).toThrow(
      /no Square catalog id/,
    );
  });
});

describe("quoteDeal", () => {
  it("prices without creating an order, and reports Square's total verbatim", async () => {
    squareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { order: { total_money: { amount: 3621 }, total_tax_money: { amount: 221 } } },
    });
    const quote = await quoteDeal({ deal: sellable("laser-tag-game-card-pack"), location: "headpinz", qty: 1 });
    expect(squareFetch).toHaveBeenCalledWith("/orders/calculate", expect.anything());
    expect(quote).toEqual({
      subtotalCents: 3400,
      taxCents: 221,
      totalCents: 3621,
      qty: 1,
      unitPriceCents: 3400,
    });
  });

  it("takes Square's rounding rather than recomputing it", async () => {
    // $45 x 6.5% = $2.925. Whatever Square does with that half-cent IS the
    // answer — a second implementation here is how displayed drifts from charged.
    squareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { order: { total_money: { amount: 4793 }, total_tax_money: { amount: 293 } } },
    });
    const quote = await quoteDeal({ deal: sellable("gel-blaster-game-card-pack"), location: "headpinz", qty: 1 });
    expect(quote.taxCents).toBe(293);
    expect(quote.totalCents).toBe(4793);
  });

  it("multiplies the subtotal from OUR price, not Square's net amounts", async () => {
    // If the Square catalog price were wrong, the subtotal must still reflect
    // what we charged for so the mismatch surfaces instead of being absorbed.
    squareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { order: { total_money: { amount: 10863 }, total_tax_money: { amount: 663 } } },
    });
    const quote = await quoteDeal({ deal: sellable("laser-tag-game-card-pack"), location: "headpinz", qty: 3 });
    expect(quote.subtotalCents).toBe(10200);
  });

  it("throws when Square refuses", async () => {
    squareFetch.mockResolvedValue({
      ok: false,
      status: 400,
      data: { errors: [{ detail: "Bad catalog id" }] },
    });
    await expect(
      quoteDeal({ deal: sellable("laser-tag-game-card-pack"), location: "headpinz", qty: 1 }),
    ).rejects.toThrow(/Bad catalog id/);
  });

  it("throws on a zero total rather than offering a free pack", async () => {
    squareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { order: { total_money: { amount: 0 }, total_tax_money: { amount: 0 } } },
    });
    await expect(
      quoteDeal({ deal: sellable("laser-tag-game-card-pack"), location: "headpinz", qty: 1 }),
    ).rejects.toThrow(/zero total/);
  });
});

describe("createDealOrder", () => {
  it("creates the order with a derived idempotency key", async () => {
    squareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { order: { id: "ORDER1", total_money: { amount: 3621 }, total_tax_money: { amount: 221 } } },
    });
    const res = await createDealOrder({
      deal: sellable("laser-tag-game-card-pack"),
      location: "headpinz",
      qty: 1,
      baseKey: "0123456789abcdef",
    });
    expect(res.orderId).toBe("ORDER1");
    expect(res.quote.totalCents).toBe(3621);
    const body = JSON.parse((squareFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.idempotency_key).toBe("deal-order-0123456789abcdef");
    // Square caps idempotency keys at 45 chars.
    expect(body.idempotency_key.length).toBeLessThanOrEqual(45);
  });

  it("prices the SAME body the quote priced", async () => {
    // The whole point of a shared builder: quote and charge cannot diverge.
    const args = { deal: sellable("gel-blaster-game-card-pack"), location: "naples" as const, qty: 2 };
    squareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { order: { total_money: { amount: 9540 }, total_tax_money: { amount: 540 } } },
    });
    await quoteDeal(args);
    const quoteBody = JSON.parse((squareFetch.mock.calls[0][1] as { body: string }).body);

    squareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { order: { id: "O2", total_money: { amount: 9540 }, total_tax_money: { amount: 540 } } },
    });
    await createDealOrder({ ...args, baseKey: "aaaaaaaaaaaaaaaa" });
    const orderBody = JSON.parse((squareFetch.mock.calls[1][1] as { body: string }).body);

    expect(orderBody.order).toEqual(quoteBody.order);
  });
});

describe("assertQuoteMatches", () => {
  const quote = { subtotalCents: 3400, taxCents: 221, totalCents: 3621, qty: 1, unitPriceCents: 3400 };

  it("passes when the buyer saw the real total", () => {
    expect(() => assertQuoteMatches(3621, quote)).not.toThrow();
  });

  it("refuses in BOTH directions and says nothing was charged", () => {
    // Under-charging is as wrong as over-charging: the displayed price is a
    // promise, and silently charging a different number breaks it either way.
    expect(() => assertQuoteMatches(3400, quote)).toThrow(/Nothing was charged/);
    expect(() => assertQuoteMatches(9999, quote)).toThrow(/Nothing was charged/);
  });

  it("names both numbers so the buyer can see what moved", () => {
    expect(() => assertQuoteMatches(3400, quote)).toThrow(/\$34\.00.*\$36\.21/);
  });
});
