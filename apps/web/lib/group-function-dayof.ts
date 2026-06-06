import { buildSquareLineItem, type CatalogPriceInfo } from "@/lib/plu-catalog-map";
import type { GroupFunctionQuote } from "@/lib/group-function-db";

/**
 * Creates the OPEN day-of Square order for a group function event. Staff redeem the loaded
 * gift card against it at the event, and the day-of payout cron applies the gift card.
 *
 * Best-effort: tries catalog-linked line items first, then ad-hoc (name + price). Returns
 * the order id, or `undefined` if both attempts fail — the caller decides how to handle it.
 * Its failure is intentionally non-fatal to the deposit charge.
 *
 * Shared by the deposit flow (initial creation) and group-quote-sync (self-heal backfill
 * when the deposit-time attempt failed — e.g. a transient Square error). Keep this the
 * single source of truth for day-of order creation.
 */
const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/**
 * Look up pricing_type + catalog price for each PLU in one batch call, so
 * buildSquareLineItem can tell whether a catalog link will honor our price.
 * Best-effort: any PLU we can't resolve is simply absent from the map, which
 * makes buildSquareLineItem fall back to an ad-hoc (price-honoring) line item.
 */
async function fetchCatalogPriceInfo(plus: string[]): Promise<Map<string, CatalogPriceInfo>> {
  const map = new Map<string, CatalogPriceInfo>();
  const ids = [...new Set(plus.filter((p) => p && p.length > 10))];
  if (ids.length === 0) return map;

  try {
    const res = await fetch(`${SQUARE_BASE}/catalog/batch-retrieve`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({ object_ids: ids }),
    });
    if (!res.ok) {
      console.warn("[gf-dayof] catalog batch-retrieve failed, treating all as ad-hoc:", res.status);
      return map;
    }
    const data = await res.json();
    for (const obj of data.objects ?? []) {
      // PLUs may point at an ITEM_VARIATION directly, or an ITEM (use its first variation).
      const v =
        obj.type === "ITEM_VARIATION"
          ? obj.item_variation_data
          : obj.item_data?.variations?.[0]?.item_variation_data;
      if (!v) continue;
      map.set(obj.id, {
        pricingType: v.pricing_type ?? "FIXED_PRICING",
        priceCents: v.price_money?.amount ?? 0,
      });
    }
  } catch (err) {
    console.warn("[gf-dayof] catalog batch-retrieve error, treating all as ad-hoc:", err);
  }
  return map;
}

export async function createDayofOrder(
  quote: GroupFunctionQuote,
  baseKey: string,
): Promise<string | undefined> {
  const rawItems = quote.line_items as Array<{
    name: string;
    price: number;
    tax: number;
    qty: number;
    total: number;
    plu: string;
  }>;
  const serviceCharges =
    quote.tax_cents > 0
      ? [
          {
            name: "Service Charge",
            amount_money: { amount: quote.tax_cents, currency: "USD" },
            calculation_phase: "SUBTOTAL_PHASE",
          },
        ]
      : [];
  const refId = `GF-${quote.event_number || quote.bmi_reservation_id}`.slice(0, 40);

  // Look up pricing_type/price per PLU so we keep the catalog link only when
  // Square will honor our (possibly overridden) price — see plu-catalog-map.ts.
  const catalogInfo = await fetchCatalogPriceInfo(rawItems.map((p) => p.plu));

  // Attempt 1: catalog-linked where safe, ad-hoc where a price override would be lost.
  try {
    const lineItems = rawItems.map((p) =>
      buildSquareLineItem(quote.center_code, p, catalogInfo.get(p.plu)),
    );
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: refId,
          line_items: lineItems,
          service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
        },
      }),
    });
    const data = await res.json();
    if (res.ok && data.order?.id) return data.order.id;
    console.warn("[gf-dayof] catalog day-of order failed, falling back to ad-hoc:", data);
  } catch (err) {
    console.warn("[gf-dayof] catalog day-of order error, falling back to ad-hoc:", err);
  }

  // Attempt 2: ad-hoc line items (name + price, no catalog link)
  try {
    const adHocItems = rawItems.map((p) => ({
      name: p.name,
      quantity: String(p.qty),
      base_price_money: { amount: Math.round(p.price * 100), currency: "USD" },
    }));
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-adhoc-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: refId,
          line_items: adHocItems,
          service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
        },
      }),
    });
    const data = await res.json();
    if (res.ok && data.order?.id) {
      console.log("[gf-dayof] day-of order created via ad-hoc fallback:", data.order.id);
      return data.order.id;
    }
    console.error("[gf-dayof] ad-hoc day-of order also failed:", data);
  } catch (err) {
    console.error("[gf-dayof] ad-hoc day-of order error:", err);
  }

  return undefined;
}
