/**
 * Mega-mode detection from DATA — PURE, no clock, no I/O.
 *
 * The authoritative Mega switch is the external delay service's
 * `megaTrackEnabled` flag (tools-track-status.vercel.app, proxied by
 * /api/track-status). But that flag is flipped by a human and lags the
 * physical barrier — on the first Mega night tested off-calendar
 * (2026-08-16) the boards would have sat blind waiting for it. The carry
 * keys cannot lie about which circuit called the newest heat, so the rule
 * here is the safety net every consumer ORs with the flag:
 *
 *     effective mega = external flag  OR  dataSaysMega(currentRaces)
 *
 * WHY THIS CAN NEVER MISFIRE ON A NORMAL DAY: the mega carry key
 * (`pandora:last-race:fasttrax:mega`) only exists on a day a Mega heat was
 * actually called — Pandora reports mega null otherwise, refreshRacesCurrent
 * never writes the key, and it TTLs out at end of ET day. Rule 1 below
 * short-circuits before any comparison happens.
 */

/** The one field the rules read. Both the client's races-current rows and the
 *  server's carry records carry it. */
export interface CalledStampLike {
  calledAt?: string | null;
}

function calledAtMs(r: CalledStampLike | null | undefined): number | null {
  if (!r?.calledAt) return null;
  const ms = Date.parse(r.calledAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * THE DATA SIGNAL: is the venue racing the combined circuit right now?
 *
 * 1. No mega row → false. (Normal days end here — the key does not exist.)
 * 2. Mega alone → true. (Clean keys: a Mega day from open, or cleared carries.)
 * 3. Mega alongside a sibling → true only when mega's calledAt parses AND is
 *    STRICTLY newer than every present sibling's parseable stamp. Ties and
 *    unparseable stamps resolve to false — "exact track first" is the
 *    documented owner semantics, so the conservative direction is normal
 *    mode. In practice ties cannot happen: distinct heats get distinct call
 *    stamps and preserveFirstCall pins each session to its own first call.
 */
export function dataSaysMega(races: {
  blue: CalledStampLike | null | undefined;
  red: CalledStampLike | null | undefined;
  mega: CalledStampLike | null | undefined;
}): boolean {
  if (!races.mega) return false;
  const siblings = [races.blue, races.red].filter((r): r is CalledStampLike => r != null);
  if (siblings.length === 0) return true;
  const mega = calledAtMs(races.mega);
  if (mega == null) return false;
  return siblings.every((s) => {
    const t = calledAtMs(s);
    return t != null && mega > t;
  });
}

/**
 * THE RESILIENCE LADDER — what "are we in mega mode" resolves to when the
 * signals disagree or go missing. PURE; callers gather the facts.
 *
 *   1. A FRESH external flag is authoritative either way — ops can run
 *      split tracks on a Mega day and the boards obey. The data signal still
 *      ORs on top of a fresh "false" flag (the flag is flipped by a human
 *      and lags the barrier; a called mega heat cannot lie).
 *   2. Flag unavailable (status app down / cache past its serve ceiling):
 *      the data signal alone decides if it says mega.
 *   3. Still blind: the DAYPLANNER verdict — did BMI schedule Mega Track
 *      sessions today (and none on Blue)? Real data from the source of
 *      truth, so a definite yes OR NO is trusted over the calendar.
 *   4. Nothing readable at all: the calendar. A Mega night with every
 *      upstream dark should still default the boards to the circuit that is
 *      almost certainly running (owner 2026-08-16: "Tuesday could remain as
 *      a hard-coded fallback").
 */
export function megaLadder(args: {
  /** Fresh external megaTrackEnabled, or null when it cannot be read. */
  flag: boolean | null;
  /** dataSaysMega over the current races. */
  dataMega: boolean;
  /** Dayplanner verdict, or null when it could not be read. */
  dayPlannerMega: boolean | null;
  /** Calendar last resort — is today (business day) a Mega day? Callers get
   *  this from `./mega-calendar`, which knows the Mega Thursday season; do
   *  NOT re-derive it from a weekday here. */
  calendarMega: boolean;
}): boolean {
  if (args.flag != null) return args.flag || args.dataMega;
  if (args.dataMega) return true;
  if (args.dayPlannerMega != null) return args.dayPlannerMega;
  return args.calendarMega;
}

/**
 * Newest-wins pick between a track's own record and the mega record — the
 * per-track twin of dataSaysMega, for readers that fall back to the mega
 * carry (the track boards' feed builder).
 *
 * Same conservatism: the exact track wins unless BOTH stamps parse and mega
 * is strictly newer. On a normal day the mega record is null and the exact
 * record flows through untouched — the same object, not a clone.
 */
export function pickCurrentSession<T extends CalledStampLike>(
  exact: T | null,
  mega: T | null,
): T | null {
  if (!mega) return exact;
  if (!exact) return mega;
  const m = calledAtMs(mega);
  const e = calledAtMs(exact);
  if (m != null && e != null && m > e) return mega;
  return exact;
}
