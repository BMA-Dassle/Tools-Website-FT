/**
 * Should a called heat still be shown? PURE — no clock reads, no I/O.
 *
 * THIS REPLACED AN OPERATING-HOURS GATE, and the reason matters.
 *
 * /api/pandora/races-current used to suppress everything outside FastTrax's
 * public opening hours. The intent was right — stop last night's last heat
 * sitting on a lobby wall at nine the next morning — but the mechanism was a
 * proxy for the wrong thing. GROUP EVENTS RUN BEFORE THE DOORS OPEN (owner
 * 2026-08-11). A private party's heat gets called at 1:30 PM on a Tuesday, the
 * venue does not open to the public until 3, and every board in the building
 * showed nothing: the website, both track TVs, the e-tickets and the briefing
 * control board. Staff had genuinely called a race and the estate disagreed.
 *
 * The property actually worth gating on is the heat's OWN AGE. A heat called
 * three minutes ago should show whether that is 1 PM, 3 PM or 1 AM. A heat called
 * eight hours ago should never show, at any hour. Age says that directly; a
 * clock window only approximated it, and approximated it wrongly for anyone
 * racing outside public hours.
 *
 * The window is deliberately set so the old behaviour is preserved at the end of
 * a night (see MAX_DISPLAY_AGE_MS) — this widens what is visible before opening
 * without making anything linger longer than it already did.
 */

/**
 * How long after its call a heat may still be displayed.
 *
 * SIX HOURS, chosen to match what the hours gate already allowed at the far end
 * of a night rather than to invent a new policy: the old rule served data until
 * 5 AM, so a heat called at 11 PM stayed visible for about six hours. Keeping the
 * same ceiling means this change only ever ADDS the pre-open case and cannot make
 * a stale session outlive what it used to.
 *
 * It also comfortably covers the gap this exists for in the first place: Pandora
 * expires its own entry ~20 minutes after a call, so the Redis copy is what keeps
 * a session on screen between heats.
 */
export const MAX_DISPLAY_AGE_MS = 6 * 3600_000;

/** The shape this cares about — anything carrying a `calledAt`. */
export interface CalledRaceLike {
  calledAt?: string | null;
}

/**
 * Is this stored heat still worth showing at `nowMs`?
 *
 * A heat with no parseable `calledAt` is SHOWN, not hidden. That is the
 * deliberate direction: the field is what the whole rule reads, and if an
 * upstream ever stops sending it, failing closed would blank every board in the
 * building at once. Failing open costs, at worst, one stale line that the Redis
 * key's own end-of-day TTL still clears.
 *
 * A future-stamped call (clock skew between us and the timing system) counts as
 * fresh — it just happened, as far as anyone standing at the track is concerned.
 */
export function raceStillDisplayable(
  race: CalledRaceLike | null | undefined,
  nowMs: number,
  maxAgeMs: number = MAX_DISPLAY_AGE_MS,
): boolean {
  if (!race) return false;
  if (!race.calledAt) return true;
  const calledAtMs = Date.parse(race.calledAt);
  if (!Number.isFinite(calledAtMs)) return true;
  const ageMs = nowMs - calledAtMs;
  if (ageMs < 0) return true;
  return ageMs <= maxAgeMs;
}

/** The shape re-call pinning cares about — a `calledAt` plus the session it
 *  belongs to. sessionId is a number per races/current and a string per the
 *  sessions list, so it is compared as a string. */
export interface CalledRaceWithSession extends CalledRaceLike {
  sessionId?: number | string | null;
}

/**
 * THE FIRST CALL IS THE CALL.
 *
 * Staff re-announce a heat — a second press in BMI a few minutes after the
 * first — and Pandora re-stamps `calledAt` on its races/current entry. Every
 * timer derived from that field (the check-in boards' countdown, the
 * "just called" takeover, race control's "checking in for X min") silently
 * restarted mid-heat (owner 2026-08-11: "we need to not do that").
 *
 * So: for the SAME session, the earliest known `calledAt` wins, and a re-call
 * changes nothing downstream. A DIFFERENT session always takes its own
 * timestamp — heats are distinct sessions, so this can never bleed one heat's
 * clock into the next. The stored side is age-gated by `raceStillDisplayable`
 * before it gets here, so yesterday's copy of a re-run session id (if such a
 * thing existed) could not pin today's.
 *
 * If the incoming entry LOST its `calledAt` (or carries an unparseable one)
 * while the stored one still has it, the stored timestamp is backfilled — the
 * countdown keeps counting from the moment it always counted from.
 */
export function preserveFirstCall<T extends CalledRaceWithSession>(
  incoming: T,
  stored: CalledRaceWithSession | null | undefined,
): T {
  if (!stored) return incoming;
  if (incoming.sessionId == null || stored.sessionId == null) return incoming;
  if (String(incoming.sessionId) !== String(stored.sessionId)) return incoming;
  const storedMs = stored.calledAt ? Date.parse(stored.calledAt) : NaN;
  if (!Number.isFinite(storedMs)) return incoming;
  const incomingMs = incoming.calledAt ? Date.parse(incoming.calledAt) : NaN;
  if (Number.isFinite(incomingMs) && incomingMs <= storedMs) return incoming;
  return { ...incoming, calledAt: stored.calledAt };
}

/** Minutes since the call, for logs and diagnostics. Null when unknown. */
export function raceAgeMinutes(
  race: CalledRaceLike | null | undefined,
  nowMs: number,
): number | null {
  if (!race?.calledAt) return null;
  const calledAtMs = Date.parse(race.calledAt);
  if (!Number.isFinite(calledAtMs)) return null;
  return Math.round((nowMs - calledAtMs) / 60_000);
}
