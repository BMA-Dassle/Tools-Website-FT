/**
 * What counts as a MATERIAL change to a signed group-function contract.
 *
 * A signed contract is an agreement about three things: what it costs, when it
 * happens, and where. Move any one of them and the executed document no longer
 * describes what the guest agreed to, so we ask them to sign again. Everything else
 * BMI can send us — corrected phone numbers, planner reassignments, internal notes —
 * changes no term of the agreement and is resent, not re-signed. Asking for a
 * signature on a typo fix trains guests to click through re-signs without reading.
 *
 * Lives in its own module, and not inline in the dispatch cron, for two reasons: a
 * Next.js `route.ts` may only export route handlers, so the rule could not otherwise
 * be tested directly; and this is the one place the definition should be edited.
 *
 * History: the rule was PRICE ONLY until 2026-09-13. Contract c31e3aec (Strikes for
 * Scholarships, FGCU, HeadPinz Fort Myers) was moved Sep 13 → Sep 19 on a signed,
 * post-paid contract — same products, same $8,538.84 total — so no signature was
 * requested and the executed PDF still named the old date, with nothing in the flow
 * that would ever correct it. Venue was the identical hole: `syncQuoteCenter` can
 * relocate an event between HeadPinz centres for zero money. Owner decision
 * 2026-09-13: date yes, venue yes.
 */

export type MaterialChangeReason = "price" | "date" | "venue";

export interface MaterialChangeFacts {
  /** total_cents moved. */
  priceChanged: boolean;
  /**
   * The event's DISPLAY date moved. Compared as the display string, not the raw
   * timestamptz — the raw value round-trips through Postgres in a different format and
   * would read as changed on every pass.
   */
  dateChanged: boolean;
  /** The event moved to another centre (`syncQuoteCenter` reported a move). */
  venueChanged: boolean;
}

export interface MaterialChangeVerdict {
  /** True when at least one term of the agreement moved. */
  isMaterial: boolean;
  /** Which terms moved, in a stable order, for logs and staff-facing notes. */
  reasons: MaterialChangeReason[];
}

export function classifyMaterialChange(facts: MaterialChangeFacts): MaterialChangeVerdict {
  const reasons: MaterialChangeReason[] = [];
  if (facts.priceChanged) reasons.push("price");
  if (facts.dateChanged) reasons.push("date");
  if (facts.venueChanged) reasons.push("venue");
  return { isMaterial: reasons.length > 0, reasons };
}

/**
 * Contract states that can be asked to re-sign: already signed, not yet finished, not
 * cancelled. `resign_required` is included so a second material change while the guest
 * is still sitting on the first one re-notifies them with the new terms rather than
 * silently syncing underneath a now-stale email.
 *
 * Deliberately excluded: `balance_link_sent` (a Square payment link is live at the old
 * total — re-signing under it would need the link reissued first, which nothing here
 * does) and `completed` (the event has happened). Both match the dispatch cron's
 * long-standing behaviour; widen this list and both paths widen together.
 *
 * Exported so the admin endpoint's SQL guard is driven by this same list rather than
 * by a second copy of it that can drift.
 */
export const RESIGNABLE_STATUSES = ["deposit_paid", "balance_charged", "resign_required"] as const;

export function canRequestResign(status: string): boolean {
  return (RESIGNABLE_STATUSES as readonly string[]).includes(status);
}
