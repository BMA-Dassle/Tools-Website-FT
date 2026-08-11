/**
 * What a deal pack costs and CONTAINS right now — the single offer authority.
 *
 * A limited offer can change two things, and both must be GENUINE:
 *
 *   - `bonusItems` — while it runs, every pack carries extras on top of its
 *     normal contents, and when it ends the same money buys strictly less
 *     (owner 2026-08-03).
 *   - `salePriceCents` — a real markdown while it runs (owner 2026-08-10:
 *     "flash sale for additional 25% off"), after which the price genuinely
 *     returns to `priceCents`.
 *
 * What stays banned is the FAKE version: a countdown to a price step-up nobody
 * intends to perform. A deadline must be attached to something that actually
 * changes — a bonus that really ends, or a discount that really ends.
 *
 * It is the single authority every surface reads through, because the bonus and
 * the sale price are the things that can silently diverge. Get it wrong and we
 * either mint value nobody paid for, charge a price the page never showed, or —
 * worse — take money for a bonus and never grant it. So the hero, the value
 * strikethrough, the minted voucher, the receipt and the recovery email all
 * resolve here, and the charge path re-resolves at charge time.
 *
 * `now` and `packsSold` are ALWAYS INJECTED, never read in here — that is what
 * makes the boundaries (the second the offer ends, the pack that exhausts the
 * allocation) testable without a fake clock or a database.
 *
 * ON OVERSELL, DELIBERATELY: two buyers can both be shown "4 left" and both buy
 * three. We do not hold inventory and we will not decline a good card to defend
 * a marketing counter — the eleventh pack of a ten-pack allocation gets the
 * bonus, and the next resolve reports zero remaining. `remaining` is clamped so
 * it can never render negative, and the overshoot is logged. The allocation
 * gates a BONUS, not a stock level; nothing physical runs out.
 */

import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";
import { countPacksSold } from "../data/deal-purchases-db";
import { etOffsetFor, type DealCatalogEntry } from "../catalog";

/** `YYYY-MM-DDTHH:mm:ss` — a wall-clock Eastern time, no offset. */
const LOCAL_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export interface DealOffer {
  /** What the card is charged per pack RIGHT NOW — the sale price while a
   *  discounted offer runs, the regular price otherwise. */
  unitPriceCents: number;
  /** The regular price, for "was $34" strikethroughs. Equals `unitPriceCents`
   *  whenever nothing is discounted, so `unitPriceCents < regularPriceCents`
   *  is the one test every surface uses for "a sale is on". */
  regularPriceCents: number;
  /** True while the limited offer is live on BOTH limits. */
  isOfferLive: boolean;
  /** Extra items each pack carries right now. Empty when no offer is running. */
  bonusItems: VoucherItem[];
  /** Guest-facing name of the bonus, e.g. "50 bonus tokens per pack". */
  bonusLabel: string | null;
  /** Deadline as a fully-offset ISO instant, or null when the offer has none. */
  endsAt: string | null;
  /** Configured allocation, or null when the offer is uncapped. */
  allocation: number | null;
  /** Packs left with the bonus, clamped at 0. Null when uncapped. */
  remaining: number | null;
  /** Packs sold, as counted by the caller. Echoed so callers can log an overshoot. */
  packsSold: number;
}

/**
 * A deadline as a real instant.
 *
 * The catalog stores wall-clock Eastern ("2026-09-07T23:59:59") because that is
 * what gets advertised, and the offset for that calendar day comes from the tz
 * database via `etOffsetFor`. Throws on a malformed value rather than letting
 * `new Date()` return Invalid Date: every comparison against NaN is false, so a
 * typo would read as "never expired" forever and the bonus would run on
 * indefinitely. Fail at the typo instead.
 */
export function dealOfferEndsAt(endsAt: string): string {
  if (!LOCAL_TS_RE.test(endsAt)) {
    throw new Error(
      `deal offer endsAt must be YYYY-MM-DDTHH:mm:ss Eastern wall-clock, got "${endsAt}"`,
    );
  }
  return `${endsAt}${etOffsetFor(endsAt.slice(0, 10))}`;
}

const NO_OFFER = {
  isOfferLive: false as const,
  bonusItems: [] as VoucherItem[],
  bonusLabel: null,
  endsAt: null,
  allocation: null,
  remaining: null,
};

/**
 * The live offer for one pack.
 *
 * @param packsSold Paid, non-refunded packs of this deal, all time — from
 *   `countPacksSold()`. Only consulted when the offer carries an allocation, so
 *   an uncapped or absent offer costs no query.
 */
export function resolveDealOffer(deal: DealCatalogEntry, now: Date, packsSold: number): DealOffer {
  const base = { unitPriceCents: deal.priceCents, regularPriceCents: deal.priceCents, packsSold };
  const offer = deal.limitedOffer;
  if (!offer) return { ...base, ...NO_OFFER };

  // A sale price must be a real markdown. Throw at the typo rather than let a
  // zero, a negative, a fraction of a cent, or a MARK-UP reach a charge: this
  // number goes straight onto a Square order line.
  const salePriceCents = offer.salePriceCents ?? null;
  if (
    salePriceCents !== null &&
    (!Number.isInteger(salePriceCents) || salePriceCents <= 0 || salePriceCents >= deal.priceCents)
  ) {
    throw new Error(
      `deal ${deal.slug}: salePriceCents must be a positive integer below priceCents ` +
        `(${deal.priceCents}), got ${salePriceCents}`,
    );
  }

  const endsAt = offer.endsAt ? dealOfferEndsAt(offer.endsAt) : null;
  const allocation = offer.allocation ?? null;

  // `>=` on both, so the advertised end really is the last instant the bonus is
  // granted and the allocation's last pack is the last one to carry it.
  const expired = endsAt !== null && now.getTime() >= new Date(endsAt).getTime();
  const soldOut = allocation !== null && packsSold >= allocation;
  const isOfferLive = !expired && !soldOut;

  return {
    ...base,
    unitPriceCents: isOfferLive && salePriceCents !== null ? salePriceCents : deal.priceCents,
    isOfferLive,
    bonusItems: isOfferLive ? offer.bonusItems : [],
    bonusLabel: offer.label,
    endsAt,
    allocation,
    remaining: allocation === null ? null : Math.max(0, allocation - packsSold),
  };
}

/**
 * Does resolving this deal's offer need a sold count?
 *
 * Lets callers skip the query entirely when no allocation is configured — which
 * is every deal until someone turns one on.
 */
export function dealNeedsSoldCount(deal: DealCatalogEntry): boolean {
  return deal.limitedOffer?.allocation != null;
}

/**
 * `resolveDealOffer` against the clock and the database — the entry point for
 * anything that needs the live offer and does not already hold one.
 *
 * Callers that quote AND charge in the same request (the purchase path) must
 * resolve ONCE and pass the result down, not call this twice: a deadline falling
 * between the two calls would promise a bonus and then mint without it.
 */
export async function currentDealOffer(
  deal: DealCatalogEntry,
  now: Date = new Date(),
): Promise<DealOffer> {
  const packsSold = dealNeedsSoldCount(deal) ? await countPacksSold(deal.slug) : 0;
  const offer = resolveDealOffer(deal, now, packsSold);
  if (offer.allocation !== null && packsSold > offer.allocation) {
    // Expected and accepted (see the header): concurrent checkouts can carry the
    // count past the allocation. Logged rather than corrected, so the overshoot
    // is visible when the numbers are reviewed after an offer runs.
    console.warn(
      `[deals] ${deal.slug} oversold its offer allocation: ${packsSold} of ${offer.allocation}`,
    );
  }
  return offer;
}
