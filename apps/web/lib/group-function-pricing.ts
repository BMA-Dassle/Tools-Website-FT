/**
 * Group-function pricing math — single source of truth.
 *
 * Pandora returns each product's `tax` as a RATE (e.g. 0.065 for 6.5%),
 * NOT a dollar amount. Line tax is therefore `rate × line-total`. An older
 * formula computed `(tax * total) / price`, which reduces to `rate × qty`
 * and badly under-counted tax (e.g. $0.65 instead of $63.76 on reservation
 * 49220090). Centralizing the math here keeps every caller — bmi-scan, the
 * dispatch/sync crons, and the one-time backfill — in agreement.
 *
 * `total_cents` everywhere is the tax-INCLUSIVE grand total (subtotal + tax);
 * the contract page, signed PDF, and Square orders all assume this.
 */

import type { HermesProduct } from "@/lib/hermes-client";

type PricedProduct = Pick<HermesProduct, "price" | "tax" | "total">;

/** Pre-tax subtotal (sum of line totals) in cents. */
export function subtotalCents(products: PricedProduct[]): number {
  const subtotal = products.reduce((s, p) => s + (p.total || 0), 0);
  return Math.round(subtotal * 100);
}

/**
 * Tax total in cents. `p.tax` is a per-line rate, so line tax = rate × total.
 * Returns 0 when the event is tax exempt.
 */
export function taxCents(products: PricedProduct[], taxExempt: boolean): number {
  if (taxExempt) return 0;
  const tax = products.reduce((s, p) => s + (p.tax || 0) * (p.total || 0), 0);
  return Math.round(tax * 100);
}
