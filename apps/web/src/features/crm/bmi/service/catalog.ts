/**
 * The product catalogue the builder's picker reads (C5).
 *
 * Names come from the tenant's Office metadata blob, which `getMetadataLookups`
 * already caches for two hours — so typing in the picker costs nothing.
 *
 * PRICES DO NOT COME FROM HERE. `projectProduct/price?productId=&date=` is one
 * Office round trip per product and a tenant's catalogue runs to hundreds of
 * them, so a LIST read is names only (`priceCents: null`) and the picker asks
 * for exactly one price when a rep picks something. That is also the correct
 * behaviour rather than merely the cheap one: the price depends on the DATE,
 * so a list priced once would be wrong for every other event on the page.
 */

import { getMetadataLookups } from "../transport";
import { priceForDate } from "./builder";
import type { CatalogProduct } from "../contracts";

/** Ceiling on a single list read, so a fat catalogue cannot wedge the picker. */
export const CATALOG_LIMIT = 200;

/**
 * Rank a catalogue hit for a query.
 *
 * A prefix match beats a word-start match beats a bare substring, so typing
 * "piz" puts "Pizza" above "Deep Dish Pizza" above "Party Pizza Add-on" —
 * the order a rep expects rather than whatever the metadata blob happened to
 * list first.
 */
export function scoreProductName(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (n.startsWith(q)) return 3;
  if (new RegExp(`\\b${escapeRegExp(q)}`).test(n)) return 2;
  if (n.includes(q)) return 1;
  return -1;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `{productId: name}` → a ranked, capped list.
 *
 * Pure, so the ordering is a unit test rather than a live probe.
 */
export function rankCatalog(
  productNames: Record<string, string>,
  query: string,
  limit = CATALOG_LIMIT,
): CatalogProduct[] {
  const q = query.trim();
  const scored: Array<{ product: CatalogProduct; score: number }> = [];
  for (const [productId, name] of Object.entries(productNames)) {
    const score = scoreProductName(name, q);
    if (q && score < 0) continue;
    scored.push({ product: { productId, name, priceCents: null }, score });
  }
  scored.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name));
  return scored.slice(0, Math.max(1, limit)).map((s) => s.product);
}

export interface CatalogRead {
  products: CatalogProduct[];
  source: "office" | "unavailable";
  error?: string;
}

/** What a metadata failure is allowed to say out loud. The detail goes to the log. */
export const CATALOG_UNAVAILABLE =
  "The product catalogue could not be read from BMI just now. Try again in a moment.";

/**
 * The catalogue for one tenant, optionally narrowed to one product WITH its
 * price for the given date.
 *
 * `productId` is the picker's "I chose this one" read: one name, one live
 * price, for that date and no other.
 */
export async function readCatalog(
  clientKey: string,
  date: string,
  opts: { q?: string; productId?: string; quantity?: number; projectId?: string } = {},
): Promise<CatalogRead> {
  let productNames: Record<string, string>;
  try {
    productNames = (await getMetadataLookups(clientKey)).productNames;
  } catch (err) {
    console.error("[crm-builder] catalogue read failed", {
      client_key: clientKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return { products: [], source: "unavailable", error: CATALOG_UNAVAILABLE };
  }

  if (opts.productId) {
    const name = productNames[opts.productId];
    // A product the metadata does not name is still priced and still quotable:
    // the blob is cached for two hours and a brand-new product must not be
    // invisible to the desk for that long.
    const priceCents = await priceForDate(clientKey, opts.productId, date, {
      quantity: opts.quantity,
      projectId: opts.projectId,
    });
    return {
      products: [
        { productId: opts.productId, name: name ?? `Product ${opts.productId}`, priceCents },
      ],
      source: "office",
    };
  }

  return { products: rankCatalog(productNames, opts.q ?? ""), source: "office" };
}
