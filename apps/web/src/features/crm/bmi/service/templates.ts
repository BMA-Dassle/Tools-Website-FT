/**
 * Quote templates — the PURE half (C5).
 *
 * Scaling a template to a party is arithmetic, so it is arithmetic: no Neon,
 * no Office, no clock. The Neon side is `../data/quote-templates-db.ts` and
 * the Office side never touches this file at all.
 *
 * THE ONE RULE WORTH REPEATING: a template says WHAT and HOW MANY. It never
 * says how much. Prices come from `projectProduct/price` for the event's own
 * date, every single time, because weekday and weekend are different numbers
 * and a price baked into a package is wrong the day after the catalogue moves.
 */

import type { QuoteTemplate, ScaledTemplateLine, TemplateLine } from "../contracts";

/**
 * How many of this line a party of `guests` needs.
 *
 *   qty = per ? max(min ?? 1, ceil(guests / per)) : (min ?? 1)
 *
 * `per` is "one of these covers this many guests" — one pizza per 4, one lane
 * per 6. `min` is the floor underneath it: a package that always includes two
 * lanes says `{per: 6, min: 2}` and a party of five still gets two.
 *
 * ROUNDS UP, always. Nineteen guests at six per lane is four lanes, not three
 * and a bit — the desk cannot sell two-thirds of a lane, and the guest who
 * would have been left standing is the whole reason the number is a ceiling.
 */
export function scaleQuantity(line: TemplateLine, guests: number): number {
  const floor = line.min && line.min > 0 ? Math.round(line.min) : 1;
  if (!line.per || line.per <= 0) return floor;
  const party = Math.max(0, Math.round(guests));
  return Math.max(floor, Math.ceil(party / line.per));
}

/**
 * A whole template scaled to one party.
 *
 * Lines that scale to nothing are DROPPED rather than sent as a zero-quantity
 * row: Office would take a zero and the quote would carry a line that charges
 * nothing and means nothing. In practice `scaleQuantity` never returns less
 * than 1, so this only fires on a hand-edited `{min: 0}`.
 */
export function scaleTemplate(template: QuoteTemplate, guests: number): ScaledTemplateLine[] {
  return template.lines
    .map((line) => ({
      productId: line.productId,
      productName: line.productName ?? null,
      quantity: scaleQuantity(line, guests),
    }))
    .filter((l) => l.quantity > 0);
}

/**
 * Turn a built quote back into a template's lines.
 *
 * Infers `per` from the quote itself: a line whose quantity divides the party
 * evenly enough to be a per-head rule gets one, everything else is recorded as
 * a flat `min`. Inference is deliberately conservative — a wrong `per` scales
 * badly on every future quote, whereas a flat line is merely unhelpful and is
 * obvious to the person editing the template.
 *
 * `guests` is the baseline the template remembers, so "start from this" can
 * scale a 20-person package to a 60-person party.
 */
export function templateLinesFromQuote(
  quote: ReadonlyArray<{ productId: string; productName: string; quantity: number }>,
  guests: number,
): TemplateLine[] {
  const party = Math.max(1, Math.round(guests));
  return quote.map((line) => {
    const qty = Math.max(1, Math.round(line.quantity));
    const per = party / qty;
    // A `per` is only believable when it comes out whole and the line actually
    // scales — one of something for a party of sixty is a flat line, not a
    // rule that says "one per sixty guests".
    const usePer = qty > 1 && Number.isInteger(per) && per >= 2;
    return usePer
      ? { productId: line.productId, productName: line.productName, per, min: 1 }
      : { productId: line.productId, productName: line.productName, min: qty };
  });
}

/**
 * "Never used" vs "used N times", for the card that makes stale packages
 * visible. A template nobody has started a quote from in a year is exactly the
 * thing sales asked to be able to SEE.
 */
export function usageLabel(uses: number): string {
  if (uses <= 0) return "Never used";
  return uses === 1 ? "Used once" : `Used ${uses} times`;
}

/** "3 lines · 20 guests" — the subtitle on a template card. */
export function templateSummary(template: QuoteTemplate): string {
  const n = template.lines.length;
  const lines = n === 1 ? "1 line" : `${n} lines`;
  return `${lines} · ${template.baselineGuests} guests`;
}
