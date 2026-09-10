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
 * TWO STACKED DISCOUNTS, TWO DIFFERENT JOBS (owner 2026-09-09, asking the right
 * question: "isn't it more than 25% off, because this is a discount on top of a
 * discount?"). It is. A pack is permanently below à-la-carte, and the flash sale
 * comes off that already-reduced price, so the discounts COMPOUND rather than
 * add: 22% then 25% is 42% off, not 47%. Both numbers are true, but they are
 * anchored to different things, and only one of them expires:
 *
 *   - The COMBINED figure (42%) is measured against what the same items cost
 *     à la carte. It leads the headline, because it is the real saving and
 *     because it is the number the page's own badge shows — a snippet promising
 *     less than the page delivers is the wrong direction to be wrong in.
 *   - The SALE figure (25%) is measured against the pack's regular price, and it
 *     is the only part that ends. The deadline attaches to it and never to the
 *     total: after the sale the pack is still 22% off, so "42% off, ends Sunday"
 *     would overstate what is expiring. Same honesty rule as the countdown —
 *     an advertised deadline has to be attached to something that really changes.
 *
 * PURE, and deliberately so: it lives beside `format.ts` rather than inside
 * `service/offer.ts` because that module reads the database, and `generateMetadata`
 * on the deal page must be able to call this without dragging server-only code
 * anywhere it does not belong. The à-la-carte numbers are passed IN, from
 * `dealSeoValue()`, rather than computed here — that keeps the per-location
 * pricing math in one place, the catalog, and this module purely about words.
 *
 * Every percentage is computed and FLOORED, never typed, so no claim here can be
 * larger than the discount actually given.
 */

import { formatDealDeadline, money } from "./format";
import type { DealCatalogEntry, DealValue } from "./catalog";

/** The offer fields the copy depends on — structural, so a `DealOffer` fits and
 *  a test can pass a literal without building one. */
export interface DealSeoOffer {
  unitPriceCents: number;
  regularPriceCents: number;
  endsAt: string | null;
}

/**
 * Whole percent off the pack's REGULAR price — the markdown that expires — or 0
 * when nothing is discounted.
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
 * `{off}` carries the COMBINED saving while a sale runs and collapses to nothing
 * otherwise — the templates are written so the sentence reads correctly either
 * way, and a test renders both states to prove it. Outside a sale the pack's
 * standing 22% is left unstated rather than advertised: it is not news, and a
 * permanent "22% Off" in a title is the sort of claim that stops meaning
 * anything.
 */
export function dealSeoTitle(
  deal: DealCatalogEntry,
  offer: DealSeoOffer,
  value: DealValue,
): string {
  const onSale = dealDiscountPct(offer) > 0;
  return fill(deal.seo.title, {
    price: money(offer.unitPriceCents),
    off: onSale && value.savingsPct > 0 ? `${value.savingsPct}% Off: ` : "",
  });
}

/**
 * The meta description for a deal page — also the OG/Twitter description and the
 * Product JSON-LD description, so all four say the same thing.
 *
 * While a sale runs the saving goes FIRST: search engines truncate around 155
 * characters and the money is the part that must survive. The expiring markdown
 * lands at the end, named as the "extra" it is, with the deadline on it alone.
 */
export function dealSeoDescription(
  deal: DealCatalogEntry,
  offer: DealSeoOffer,
  value: DealValue,
): string {
  const salePct = dealDiscountPct(offer);
  const price = money(offer.unitPriceCents);
  if (salePct === 0) return fill(deal.seo.description, { price });

  const when = offer.endsAt ? `through ${formatDealDeadline(offer.endsAt)}` : "for a limited time";
  const lead = `Save ${money(value.savingsCents)} (${value.savingsPct}% off a ${money(
    value.compareAtCents,
  )} value) — `;
  return lead + fill(deal.seo.saleDescription, { price, salePct: String(salePct), deadline: when });
}

/* ───────────────────────────── the /deals hub ───────────────────────────── */

/**
 * The hub covers every pack at once, so each figure has to hold for ALL of them:
 * stated exactly when they agree, and as "up to" when they do not. Advertising
 * one pack's 42% as if it applied to the other's 41% is the same overstatement
 * `savingsPct`'s floor prevents one level down.
 */
function acrossPacks(pcts: number[], capitalised: boolean): string {
  if (new Set(pcts).size === 1) return `${pcts[0]}%`;
  return `${capitalised ? "Up" : "up"} to ${Math.max(...pcts)}%`;
}

export interface DealsHubEntry {
  offer: DealSeoOffer;
  value: DealValue;
}

/**
 * Title and description for `/deals` — sale-aware, same two-anchor rule as a
 * single pack: the combined saving leads, and the deadline names only the
 * markdown that expires.
 *
 * The SALE title gets a shorter tail than the resting one. With "Up to 42% Off"
 * in front, the full phrase ran to 68 characters and Google's truncation landed
 * inside the product list — a title that loses its ending to advertise a number
 * has traded the wrong thing away. Composed here rather than in the page so the
 * length cap is enforced by a test instead of by whoever last edited the copy.
 */
export function dealsHubSeo(
  entries: readonly DealsHubEntry[],
  copy: { brand: string; tail: string; saleTail: string; description: string },
): { title: string; description: string } {
  const live = entries.filter((e) => dealDiscountPct(e.offer) > 0);
  if (live.length === 0) {
    return { title: `${copy.brand} — ${copy.tail}`, description: copy.description };
  }

  const totals = live.map((e) => e.value.savingsPct);
  const sales = live.map((e) => dealDiscountPct(e.offer));
  const deadlines = live.map((e) => e.offer.endsAt).filter((e): e is string => e !== null);
  // The EARLIEST live deadline: the first moment the sentence stops being true.
  const soonest =
    deadlines.length > 0 ? deadlines.reduce((a, b) => (new Date(a) <= new Date(b) ? a : b)) : null;
  const when = soonest ? `through ${formatDealDeadline(soonest)}` : "for a limited time";

  return {
    title: `${copy.brand} — ${acrossPacks(totals, true)} Off ${copy.saleTail}`,
    description:
      `Save ${acrossPacks(totals, false)} — extra ${acrossPacks(sales, false)} off ${when}. ` +
      copy.description,
  };
}
