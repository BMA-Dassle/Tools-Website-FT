/**
 * PLU → Square Catalog ID mapping for group function products.
 *
 * Hermes products include a `plu` field that is actually the Square
 * catalog object ID (e.g. "CRMNHGI3WP2ILKJ4TTXFZWBL"). No translation
 * needed — pass through directly as catalog_object_id on the Square order.
 *
 * If a PLU is empty or missing, fall back to an ad-hoc line item
 * (name + price, no catalog link). This is fine for revenue recognition.
 *
 * CRITICAL — price overrides vs. catalog pricing_type:
 *   Square only honors `base_price_money` on a catalog-linked line item when the
 *   variation is VARIABLE_PRICING. For a FIXED_PRICING variation it SILENTLY
 *   ignores our price and charges the catalog price. Group-function quotes
 *   routinely override prices (e.g. a $26.99 catalog "Adult Race" sold as a
 *   $399.99 "Race Blue Starter" group package). If we keep the catalog link on
 *   such an item, Square rings it at $26.99 and the override is lost.
 *   (Incident 2026-06-05: #3286 under-charged by $1,464.53 — three race lines
 *   rang at $26.99 instead of $399.99.)
 *
 *   So we only keep the catalog link when the price WILL be honored:
 *     - VARIABLE_PRICING variation, or
 *     - FIXED_PRICING variation whose catalog price already equals the quote price.
 *   Otherwise we drop the link and build an ad-hoc line item so the quoted
 *   (overridden) price is what's charged. Pass `catalogInfo` (from
 *   `fetchCatalogPriceInfo`) so this decision can be made; without it we can't
 *   prove the link is safe, so we fall back to ad-hoc.
 */

export type CatalogPriceInfo = {
  pricingType: "FIXED_PRICING" | "VARIABLE_PRICING" | string;
  priceCents: number;
};

export type SquareLineItem = {
  name?: string;
  quantity: string;
  catalog_object_id?: string;
  base_price_money: { amount: number; currency: string };
};

export function buildSquareLineItem(
  _centerCode: string,
  product: { name: string; price: number; qty: number; plu: string },
  catalogInfo?: CatalogPriceInfo,
): SquareLineItem {
  const quoteCents = Math.round(product.price * 100);
  const base = {
    quantity: String(product.qty),
    base_price_money: { amount: quoteCents, currency: "USD" },
  };

  const hasPlu = !!product.plu && product.plu.length > 10;

  if (hasPlu && catalogInfo) {
    const priceWillBeHonored =
      catalogInfo.pricingType === "VARIABLE_PRICING" || catalogInfo.priceCents === quoteCents;
    if (priceWillBeHonored) {
      // Safe to keep the catalog link — Square will charge our price.
      return { catalog_object_id: product.plu, ...base };
    }
    // Fixed-price catalog item with a price override: linking would lose the
    // override (Square charges the catalog price). Build ad-hoc to honor it.
    return { name: product.name, ...base };
  }

  // No PLU, or no catalog info to prove the link is safe → ad-hoc.
  return { name: product.name, ...base };
}
