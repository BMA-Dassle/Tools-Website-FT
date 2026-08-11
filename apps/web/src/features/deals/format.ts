/**
 * Guest-facing formatting for launch offers. Pure — no DB, no clock of its own,
 * safe to import from a server component and a client one alike.
 *
 * It lives apart from `service/offer.ts` deliberately: that module reads the
 * database, so importing it into the buy panel would drag server-only code into
 * the client bundle. The panel needs these two functions and the `DealOffer`
 * TYPE (erased at compile time), and nothing else.
 */

/**
 * Below this, the deadline reads as a running clock; above it, as a date.
 *
 * A countdown showing "23 days" is not urgency, it is furniture — people learn
 * to ignore it, and by the time it means something they have stopped seeing it.
 * Two days is the point where "Sunday" starts feeling further away than the
 * clock does.
 */
export const COUNTDOWN_THRESHOLD_MS = 48 * 60 * 60 * 1000;

const ET = "America/New_York";

/**
 * "Sunday, September 7" — the deadline as a date, in Eastern time.
 *
 * Always formatted in ET regardless of where it is rendered: the sale ends at a
 * time in Fort Myers, and a buyer's browser in another timezone must still be
 * told the date we advertised, not a local translation of it.
 */
export function formatDealDeadline(endsAtIso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(endsAtIso));
}

/** "September 7" — the compact form, for a badge or a card. */
export function formatDealDeadlineShort(endsAtIso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    month: "short",
    day: "numeric",
  }).format(new Date(endsAtIso));
}

/**
 * A remaining duration as a clock: `1d 6h`, `2h 14m`, `48m 07s`.
 *
 * Seconds only appear in the last hour, where they are the difference between
 * urgency and decoration. Above that they would just burn a re-render a second
 * for a digit nobody is watching.
 *
 * Returns null once the duration is up, so callers render the ended state
 * rather than "0m 00s", which reads like a bug.
 */
export function formatCountdown(remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Dollars, with cents dropped when they are zero — "$34", "$36.21". */
export function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * The fine-print sentence for a running limited offer.
 *
 * Says exactly what ends and exactly when. For a bonus offer, the part that
 * matters is that the PRICE is not what changes — a guest who reads "limited
 * time" beside a countdown will reasonably assume the price is about to go up,
 * and leaving that assumption standing when it is false is the same deception
 * as printing it. For a genuine sale price, the honest statement is the
 * opposite one: this IS a discount, and after the date the pack returns to its
 * regular price — which it really does, through the same resolver that charges.
 *
 * Built rather than templated because the shapes are genuinely different
 * sentences: "whichever comes first" is only true when there ARE two limits, and
 * printing it beside a single one is the sort of boilerplate that makes a real
 * deadline read as fake. Returns null when no offer is running.
 */
export function offerFinePrint(offer: {
  isOfferLive: boolean;
  unitPriceCents: number;
  regularPriceCents: number;
  bonusItems: readonly unknown[];
  bonusLabel: string | null;
  endsAt: string | null;
  allocation: number | null;
}): string | null {
  if (!offer.isOfferLive) return null;

  const limits: string[] = [];
  if (offer.endsAt) limits.push(`through ${formatDealDeadline(offer.endsAt)}`);
  if (offer.allocation !== null) limits.push(`while the first ${offer.allocation} packs last`);
  if (limits.length === 0) return null;

  const clause = limits.length === 2 ? `${limits.join(" or ")}, whichever comes first` : limits[0];

  if (offer.unitPriceCents < offer.regularPriceCents) {
    const bonusTail =
      offer.bonusItems.length > 0 && offer.bonusLabel
        ? `, and the ${offer.bonusLabel} ends with it`
        : "";
    return (
      `${money(offer.unitPriceCents)} is a limited-time sale price, available ${clause}. ` +
      `After that the pack returns to its regular ${money(offer.regularPriceCents)}${bonusTail}.`
    );
  }

  if (offer.bonusItems.length === 0 || !offer.bonusLabel) return null;
  return (
    `${offer.bonusLabel} is a limited-time extra, included ${clause}. ` +
    `The pack price stays ${money(offer.unitPriceCents)} — after the offer ends, ` +
    `the same pack simply no longer includes the bonus.`
  );
}
