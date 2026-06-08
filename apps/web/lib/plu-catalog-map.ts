/**
 * PLU → Square Catalog ID mapping for group function products.
 *
 * Hermes products include a `plu` field that is actually the Square catalog
 * object ID (an ITEM_VARIATION id, e.g. "LPOHFAIUE72CMYX7SLSMLMDO"). No
 * translation needed — pass through directly as `catalog_object_id`.
 *
 * Price overrides + catalog links COEXIST. We always send `base_price_money`
 * alongside the catalog link, and Square honors our amount on BOTH pricing
 * types — verified against /orders/calculate:
 *   - FIXED_PRICING  $26.99 catalog item + base_price_money $399.99  → rings $399.99
 *   - VARIABLE_PRICING ($0 catalog)        + base_price_money $399.99  → rings $399.99
 * In both cases the line keeps its catalog_object_id, so item-sales reporting
 * still attributes the sale. The catalog price is only a default; the order's
 * `base_price_money` overrides it.
 *
 * HISTORY — do not "drop the link on override" again:
 *   The 2026-06-05 #3286 undercharge ($26.99 rung instead of $399.99) was
 *   originally blamed on "Square silently ignores base_price_money on FIXED
 *   items." That was a MISDIAGNOSIS. The real cause: that order was created
 *   before base_price_money was added to catalog lines (2026-06-03 fix), so it
 *   carried only catalog_object_id and Square used the catalog price. Once
 *   base_price_money is always sent, linking is safe for overrides too. The
 *   "drop the catalog link when price != catalog price" overcorrection only
 *   destroyed item-sales attribution. See tasks/lessons.md.
 *
 * If a PLU is empty/missing, fall back to an ad-hoc line (name + price).
 */

export type SquareLineItem = {
  name?: string;
  quantity: string;
  catalog_object_id?: string;
  base_price_money: { amount: number; currency: string };
};

export function buildSquareLineItem(
  _centerCode: string,
  product: { name: string; price: number; qty: number; plu: string },
): SquareLineItem {
  const base = {
    quantity: String(product.qty),
    base_price_money: { amount: Math.round(product.price * 100), currency: "USD" },
  };

  const hasPlu = !!product.plu && product.plu.length > 10;

  // Keep the catalog link whenever we have a PLU — base_price_money below
  // carries our (possibly overridden) price, which Square honors over the
  // catalog default on both FIXED and VARIABLE pricing. Preserves reporting.
  if (hasPlu) return { catalog_object_id: product.plu, ...base };

  // No PLU → ad-hoc line (name + price).
  return { name: product.name, ...base };
}
