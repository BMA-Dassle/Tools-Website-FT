/**
 * Shared Square day-of order builder.
 *
 * Extracted verbatim from unified-reserve.ts's inline `createDayofOrder` closure
 * so the post-booking combo add-on (features/combo-addon) creates its day-of
 * orders through the EXACT same path as the original booking — same idempotency
 * key shape, same location-tax handling, same catalog/price-override line shape.
 * One source of truth for "make the open day-of order the gift card settles
 * against at check-in (lane-open / race-dayof-pay)".
 *
 * Day-of orders are intentionally left OPEN (no payment here) — the gift card
 * funds them at check-in. See tasks/lessons.md (bowling stays check-in-gated).
 */
import { LOCATION_TAX } from "../data/square-catalog-map";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** One line on a day-of order — a catalog item (optionally price-overridden) or
 *  an ad-hoc named line. Mirrors the SquareLineItem shape in unified-reserve. */
export interface DayofLineItem {
  name: string;
  /** Square quantity is a string ("1", "2", …). */
  quantity: string;
  catalogObjectId?: string;
  basePriceMoney?: { amount: number; currency: "USD" };
  note?: string;
}

export interface CreateDayofOrderArgs {
  locationId: string;
  lineItems: DayofLineItem[];
  /** Deterministic idempotency seed — `dayof-${baseKey}-${keySuffix}`. */
  baseKey: string;
  /** Per-order suffix so a multi-entity (combo) booking keys each order uniquely. */
  keySuffix: string;
  /** Idempotency-key namespace — defaults to "unified-dayof" to byte-match the
   *  original booking. The add-on passes its own so retries never collide. */
  keyPrefix?: string;
  squareCustomerId?: string;
}

/**
 * Create ONE Square day-of order at `locationId`, applying that location's sales
 * tax (catalog tax id from LOCATION_TAX) at ORDER scope. Returns the order id +
 * tax-inclusive total. Throws on a Square error.
 */
export async function createDayofOrder(
  args: CreateDayofOrderArgs,
): Promise<{ orderId: string; totalCents: number }> {
  const { locationId, lineItems, baseKey, keySuffix, squareCustomerId } = args;
  const keyPrefix = args.keyPrefix ?? "unified-dayof";
  const taxCatalogId = LOCATION_TAX[locationId];
  const orderTaxes = taxCatalogId
    ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
    : [];
  const res = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `${keyPrefix}-${baseKey}-${keySuffix}`,
      order: {
        location_id: locationId,
        ...(squareCustomerId ? { customer_id: squareCustomerId } : {}),
        line_items: lineItems.map((li) => {
          if (li.catalogObjectId) {
            return {
              catalog_object_id: li.catalogObjectId,
              quantity: li.quantity,
              ...(li.basePriceMoney ? { base_price_money: li.basePriceMoney } : {}),
              ...(li.note ? { note: li.note } : {}),
            };
          }
          return {
            name: li.name,
            quantity: li.quantity,
            base_price_money: li.basePriceMoney,
            ...(li.note ? { note: li.note } : {}),
          };
        }),
        ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
      },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    const sqErr = data.errors?.[0];
    throw new Error(`Square order failed: ${sqErr?.code}: ${sqErr?.detail}`);
  }
  const orderId: string = data.order?.id;
  if (!orderId) throw new Error("Square order returned no ID");
  return { orderId, totalCents: data.order?.total_money?.amount ?? 0 };
}
