/**
 * PLU → Square Catalog ID mapping for group function products.
 *
 * Hermes products include a PLU (Price Look Up) code. This map
 * translates those PLU codes into Square catalog variation IDs so
 * the day-of Square order has proper catalog linkage for reporting.
 *
 * If a PLU is not mapped, the day-of order falls back to an ad-hoc
 * line item (name + price, no catalog link). This is fine for
 * revenue recognition — it just won't roll up in Square's catalog
 * sales reports.
 *
 * To populate: run `GET /products/:center` against Hermes for each
 * center, then match PLU codes against the Square catalog.
 */

// ── HeadPinz Fort Myers ─────────────────────────────────────────────
// PLU code → Square catalog variation ID
const PLU_HPFM: Record<string, string> = {
  // Populated by cross-referencing Hermes /products/10.48.0.14
  // with Square catalog for location TXBSQN0FEKQ11.
  // Example: "1234": "CATALOG_VARIATION_ID_HERE",
};

// ── HeadPinz Naples ─────────────────────────────────────────────────
const PLU_HPN: Record<string, string> = {
  // Populated by cross-referencing Hermes /products/10.40.0.43
  // with Square catalog for location PPTR5G2N0QXF7.
};

// ── FastTrax Fort Myers ─────────────────────────────────────────────
const PLU_FT: Record<string, string> = {
  // Populated by cross-referencing Hermes /products/10.48.0.14_FT
  // with Square catalog for location LAB52GY480CJF.
};

const PLU_MAPS: Record<string, Record<string, string>> = {
  "fort-myers": PLU_HPFM,
  naples: PLU_HPN,
  fasttrax: PLU_FT,
};

export function lookupSquareCatalogByPlu(centerCode: string, plu: string): string | null {
  return PLU_MAPS[centerCode]?.[plu] ?? null;
}

/**
 * Build a Square order line item from a Hermes product.
 * Uses catalog variation if PLU is mapped, falls back to ad-hoc.
 */
export function buildSquareLineItem(
  centerCode: string,
  product: { name: string; price: number; qty: number; plu: string },
): {
  name?: string;
  quantity: string;
  catalog_object_id?: string;
  base_price_money?: { amount: number; currency: string };
} {
  const catalogId = lookupSquareCatalogByPlu(centerCode, product.plu);

  if (catalogId) {
    return {
      catalog_object_id: catalogId,
      quantity: String(product.qty),
    };
  }

  return {
    name: product.name,
    quantity: String(product.qty),
    base_price_money: {
      amount: Math.round(product.price * 100),
      currency: "USD",
    },
  };
}
