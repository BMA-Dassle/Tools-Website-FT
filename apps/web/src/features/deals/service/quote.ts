/**
 * Deal-pack pricing — ONE order shape, priced by Square, used by both the
 * displayed total and the charge.
 *
 * Why Square and not arithmetic here: the owner's decision is "$34 plus tax,
 * charged as one line item", and Square computes the tax from the county tax
 * object on the order. $45 at Lee County's 6.5% is $2.925, which has to round;
 * any second implementation of that rounding is a displayed-total that
 * eventually disagrees with the captured amount, and this repo hard-fails on
 * that mismatch by rule. So `buildDealOrder` is the single source of the order
 * body, `quoteDeal` prices it WITHOUT persisting anything (Square's
 * /orders/calculate), and `createDealOrder` persists the identical body for the
 * charge. The purchase path then re-quotes and refuses if the number moved.
 *
 * Tax is applied to the WHOLE line (owner decision): no allocation between the
 * attraction half of the pack and the game-card half.
 */

import { squareFetch, squareErrorDetail } from "~/features/account/data/square-client";
import { SQUARE_LOCATIONS, LOCATION_TAX } from "~/features/booking/data/square-catalog-map";
import {
  dealSquareCatalogId,
  type DealCatalogEntry,
  type DealLocationKey,
} from "../catalog";

/** Square location id per deal location. */
export const DEAL_SQUARE_LOCATION: Record<DealLocationKey, string> = {
  headpinz: SQUARE_LOCATIONS.HEADPINZ_FM,
  naples: SQUARE_LOCATIONS.HEADPINZ_NAP,
};

/** Line-level tax uid inside the order body (Square's own naming convention). */
const TAX_UID = "line-tax";

export interface DealQuote {
  /** Pre-tax, qty × unit price. */
  subtotalCents: number;
  taxCents: number;
  /** What the card is charged. The only number the buyer should ever be shown. */
  totalCents: number;
  qty: number;
  unitPriceCents: number;
}

export class DealQuoteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The order body. ONE catalog-backed line, quantity = packs, price overridden
 * from the registry — the catalog id is for Square/QBO categorisation, never for
 * pricing (same doctrine as token packages and race packs).
 */
export function buildDealOrder(args: {
  deal: DealCatalogEntry;
  location: DealLocationKey;
  qty: number;
}): Record<string, unknown> {
  const { deal, location, qty } = args;
  const catalogObjectId = dealSquareCatalogId(deal);
  if (!catalogObjectId) {
    // Refuse rather than fall back to an ad-hoc line: an uncategorised sale is
    // invisible in QBO and cannot be retro-fitted onto a captured payment.
    throw new DealQuoteError(
      "NOT_SELLABLE",
      `${deal.name} has no Square catalog id configured yet`,
    );
  }
  const squareLocation = DEAL_SQUARE_LOCATION[location];
  const taxCatalogId = LOCATION_TAX[squareLocation];
  if (!taxCatalogId) {
    throw new DealQuoteError("NO_TAX_OBJECT", `no tax object for Square location ${squareLocation}`);
  }

  return {
    location_id: squareLocation,
    line_items: [
      {
        quantity: String(qty),
        base_price_money: { amount: deal.priceCents, currency: "USD" },
        catalog_object_id: catalogObjectId,
        item_type: "ITEM",
        name: deal.name,
        applied_taxes: [{ tax_uid: TAX_UID }],
      },
    ],
    taxes: [{ uid: TAX_UID, catalog_object_id: taxCatalogId, scope: "LINE_ITEM" }],
    note: `Deal pack — ${deal.name} ×${qty}`,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function totalsFromOrder(order: any, qty: number, unitPriceCents: number): DealQuote {
  const totalCents = Number(order?.total_money?.amount ?? 0);
  const taxCents = Number(order?.total_tax_money?.amount ?? 0);
  // Derive the subtotal from our own authority rather than Square's
  // net_amounts, so a mis-set catalog price shows up as a mismatch instead of
  // being silently accepted.
  const subtotalCents = unitPriceCents * qty;
  return { subtotalCents, taxCents, totalCents, qty, unitPriceCents };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Price a pack WITHOUT creating an order. `/orders/calculate` is Square's
 * dry-run: it applies taxes and returns the totals but persists nothing, so the
 * buy panel can re-price on every quantity change without littering the
 * merchant's order list with abandoned drafts.
 */
export async function quoteDeal(args: {
  deal: DealCatalogEntry;
  location: DealLocationKey;
  qty: number;
}): Promise<DealQuote> {
  const order = buildDealOrder(args);
  const { ok, data } = await squareFetch<{ order?: unknown; errors?: unknown }>(
    "/orders/calculate",
    { method: "POST", body: JSON.stringify({ order }) },
  );
  if (!ok || !data?.order) {
    throw new DealQuoteError("QUOTE_FAILED", `Square could not price this: ${squareErrorDetail(data)}`);
  }
  const quote = totalsFromOrder(data.order, args.qty, args.deal.priceCents);
  if (quote.totalCents <= 0) {
    throw new DealQuoteError("QUOTE_FAILED", "Square returned a zero total");
  }
  return quote;
}

/**
 * Create the real order for the charge and return its totals.
 *
 * `idempotency_key` is derived from the caller's `baseKey` so a retried request
 * reuses the same order rather than creating a second one.
 */
export async function createDealOrder(args: {
  deal: DealCatalogEntry;
  location: DealLocationKey;
  qty: number;
  baseKey: string;
}): Promise<{ orderId: string; quote: DealQuote }> {
  const order = buildDealOrder(args);
  const { ok, data } = await squareFetch<{ order?: { id?: string }; errors?: unknown }>("/orders", {
    method: "POST",
    body: JSON.stringify({ idempotency_key: `deal-order-${args.baseKey}`, order }),
  });
  const orderId = data?.order?.id;
  if (!ok || !orderId) {
    throw new DealQuoteError(
      "ORDER_FAILED",
      `Square order create failed: ${squareErrorDetail(data)}`,
    );
  }
  return { orderId, quote: totalsFromOrder(data.order, args.qty, args.deal.priceCents) };
}

/**
 * Guard the price↔charge pairing: the amount the buyer was shown must equal the
 * amount the order says. A mismatch hard-fails — never charge the difference
 * silently in either direction.
 */
export function assertQuoteMatches(shownTotalCents: number, quote: DealQuote): void {
  if (shownTotalCents !== quote.totalCents) {
    throw new DealQuoteError(
      "PRICE_CHANGED",
      `The total changed while you were checking out (you saw $${(shownTotalCents / 100).toFixed(2)}, it is now $${(quote.totalCents / 100).toFixed(2)}). Nothing was charged — please review and try again.`,
    );
  }
}
