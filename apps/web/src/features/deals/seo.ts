/**
 * The search-facing copy for a deal pack — title, description, discount percent.
 *
 * WHY THIS EXISTS. The catalog's `seo.title` and `seo.description` used to carry
 * a typed-in "$34" / "$45". That is fine right up until a sale runs, and then
 * every search impression advertises a price the page does not charge: the sale
 * is invisible in the one place a buyer decides whether to click, and the
 * snippet contradicts the visible price, which is what suppresses Google's price
 * rich result rather than earning it. Copy that states a price has to be derived
 * from the same offer the charge is derived from — the rule the value table, the
 * fine print and the Naples popup already follow.
 *
 * PURE, and deliberately so: it lives beside `format.ts` rather than inside
 * `service/offer.ts` because that module reads the database, and `generateMetadata`
 * on the deal page must be able to call this without dragging server-only code
 * anywhere it does not belong.
 *
 * HONEST BY CONSTRUCTION. The percentage is computed from the two prices, never
 * typed — so it cannot claim 25% while charging 20% off — and it is FLOORED, the
 * same direction `dealValue` rounds, because a discount overstated by a rounding
 * rule is still a discount overstated. The sale clause only appears while the
 * offer genuinely discounts, and it names the real deadline, so the snippet
 * expires exactly when the price does.
 */

import { formatDealDeadline, money } from "./format";
import type { DealCatalogEntry } from "./catalog";

/** The offer fields the copy depends on — structural, so a `DealOffer` fits and
 *  a test can pass a literal without building one. */
export interface DealSeoOffer {
  unitPriceCents: number;
  regularPriceCents: number;
  endsAt: string | null;
}

/**
 * Whole percent off, floored, or 0 when nothing is discounted.
 *
 * Computed in integer cents rather than by dividing floats: `1 - 2550 / 3400`
 * happens to be exact today, but a future price where it is not would round a
 * 24.9% discount up to "25% off" in a page title, which is an advertised claim.
 */
export function dealDiscountPct(offer: DealSeoOffer): number {
  const { unitPriceCents, regularPriceCents } = offer;
  if (unitPriceCents >= regularPriceCents || regularPriceCents <= 0) return 0;
  return Math.floor(((regularPriceCents - unitPriceCents) * 100) / regularPriceCents);
}

/**
 * Fill a copy template's `{token}` slots.
 *
 * Throws on a slot nobody filled instead of shipping a literal "{price}" into a
 * page title. A typo in a template is silent everywhere else — it renders,
 * indexes, and looks almost right in a snippet — so this is the one place it can
 * be made loud.
 */
function fill(template: string, tokens: Record<string, string>): string {
  const out = template.replace(/\{(\w+)\}/g, (whole, key: string) => tokens[key] ?? whole);
  const leftover = out.match(/\{\w+\}/);
  if (leftover) {
    throw new Error(`deal SEO template has an unfilled token ${leftover[0]}: "${template}"`);
  }
  return out;
}

/**
 * The `<title>` for a deal page.
 *
 * While a sale runs the percent leads, because it is the reason to click and
 * because a truncated title keeps its head and loses its tail. Outside a sale
 * the copy is exactly what it always was, with the real price in it.
 */
export function dealSeoTitle(deal: DealCatalogEntry, offer: DealSeoOffer): string {
  const base = fill(deal.seo.title, { price: money(offer.unitPriceCents) });
  const pct = dealDiscountPct(offer);
  return pct > 0 ? `${pct}% Off: ${base}` : base;
}

/**
 * The meta description for a deal page — also the OG/Twitter description and the
 * Product JSON-LD description, so all four say the same thing.
 *
 * The sale clause goes FIRST: search engines truncate around 160 characters and
 * the saving is the part that must survive. It names the deadline when there is
 * one, and says "for a limited time" when the offer is capped by allocation
 * instead — never a deadline we did not actually set.
 */
export function dealSeoDescription(deal: DealCatalogEntry, offer: DealSeoOffer): string {
  const base = fill(deal.seo.description, { price: money(offer.unitPriceCents) });
  const pct = dealDiscountPct(offer);
  if (pct === 0) return base;
  const when = offer.endsAt ? `through ${formatDealDeadline(offer.endsAt)}` : "for a limited time";
  return `Save ${pct}% ${when} — ${base}`;
}
