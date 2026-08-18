/**
 * HOW MANY OF A CALLED HEAT ARE THROUGH THE DESK — and, just as importantly,
 * WHETHER WE ACTUALLY KNOW.
 *
 * The check-in board reads this next to the heat it counts. Until 2026-08-18 a
 * roster read that failed left the row at its initialised `0/0`, and the board
 * printed that as fact: "0/0 · 0 still to scan" over a heat with five racers
 * standing at the desk, then "5/5 all here" on the next poll when the upstream
 * answered. Measured live that evening, the displayed value changed on EIGHT OF
 * TEN consecutive polls while the true roster never moved.
 *
 * Two rules come out of that, and this module exists so they are stated once:
 *
 *   1. UNKNOWN IS NOT ZERO. A read that failed reports `null`, which the board
 *      renders as "—". A zero must have been counted.
 *   2. A FAILED READ KEEPS THE LAST NUMBER WE COUNTED, for that same session.
 *      The roster of a heat that is already being called barely moves, so the
 *      previous count is very nearly right; a blank is certainly useless.
 *
 * Both are scoped TO ONE SESSION ID. Nothing here may carry a count across a
 * heat roll — that was the other half of the same incident: a cached snapshot
 * kept serving heat 26's number after Pandora had rolled to heat 27, so the
 * board named the wrong heat for ~26 seconds.
 */

/** A roster count, with the honesty about it attached. */
export interface RosterCount {
  /** Counted, or null when the read failed and nothing was known before. */
  checkedIn: number | null;
  total: number | null;
  /** When these numbers were read from the upstream. null = never read. */
  atMs: number | null;
  /**
   * True when the numbers are the last ones we counted rather than a fresh
   * read. The board dims them; nothing else changes. A stale count is still a
   * count, which is the whole point of keeping it.
   */
  stale: boolean;
}

/** A count younger than this is served as-is — no upstream read at all. Shared
 *  through Redis, so every lambda instance answers from the same one and the
 *  board cannot flip between two instances' disagreeing snapshots. */
export const ROSTER_FRESH_MS = 10_000;

/**
 * How long a last-known count may stand in for a failed read.
 *
 * Generous on purpose: a called session lives ~20 minutes, and for that whole
 * window a count from earlier in the SAME heat beats a blank. Past it we would
 * be showing something from a heat that has surely ended, so it lapses to
 * unknown rather than lying quietly.
 */
export const ROSTER_MAX_STALE_MS = 30 * 60_000;

/** What a fresh upstream read produced, or null if it failed. */
export interface RosterRead {
  checkedIn: number;
  total: number;
}

/** Nothing known, nothing pretended. */
export const UNKNOWN_ROSTER: RosterCount = {
  checkedIn: null,
  total: null,
  atMs: null,
  stale: false,
};

/** Is this stored count still worth serving without re-reading? */
export function rosterIsFresh(entry: RosterCount | null, nowMs: number): boolean {
  if (!entry || entry.atMs === null || entry.total === null) return false;
  const age = nowMs - entry.atMs;
  // A stamp from the future is a clock problem, not freshness — re-read.
  if (age < 0) return false;
  return age < ROSTER_FRESH_MS;
}

/** Is this stored count still worth showing when a re-read has failed? */
export function rosterIsUsableWhenStale(entry: RosterCount | null, nowMs: number): boolean {
  if (!entry || entry.atMs === null || entry.total === null) return false;
  const age = nowMs - entry.atMs;
  if (age < 0) return false;
  return age < ROSTER_MAX_STALE_MS;
}

/**
 * THE DECISION, in one place: what do we report for this session right now?
 *
 * `fresh` is the read we just made (null if it failed or was never attempted),
 * `lastKnown` is what Redis held for THIS SAME session id. The caller is
 * responsible for only ever passing a `lastKnown` read under this session's own
 * key — see the rule about heat rolls at the top of this file.
 */
export function resolveRosterCount(
  fresh: RosterRead | null,
  lastKnown: RosterCount | null,
  nowMs: number,
): RosterCount {
  if (fresh) {
    return { checkedIn: fresh.checkedIn, total: fresh.total, atMs: nowMs, stale: false };
  }
  if (rosterIsUsableWhenStale(lastKnown, nowMs)) {
    // Non-null by the guard above; re-stated so the count carries its own age.
    return {
      checkedIn: lastKnown!.checkedIn,
      total: lastKnown!.total,
      atMs: lastKnown!.atMs,
      stale: true,
    };
  }
  return UNKNOWN_ROSTER;
}

/**
 * WE ALREADY KNOW WHAT WE DID — apply it as a FLOOR under the upstream's answer.
 *
 * Every green scan on this board is our own write. We do not need Pandora to
 * tell us it happened; we need Pandora only for what we could not have seen —
 * the roster changing, or somebody checked in at another station. So the desk
 * keeps a set of the people IT scanned into a session, and the count reported
 * for that session may never fall below the size of that set.
 *
 * This kills the last way the number could go backwards. A racer scans, the
 * board reads 4/5, and a poll a second later catches Pandora before it has
 * caught up and reads 3/5 — the count going DOWN while a queue of people is
 * visibly going through the desk. With the floor, a fresh read can only ever
 * raise the number or agree with it.
 *
 * Capped at `total`, because the floor counts our scans and the total is the
 * grid — a stale roster read must not produce "6 of 5".
 */
export function applyLocalFloor(count: RosterCount, locallyCredited: number): RosterCount {
  if (count.total === null || count.checkedIn === null) return count;
  if (locallyCredited <= count.checkedIn) return count;
  return { ...count, checkedIn: Math.min(count.total, locallyCredited) };
}

/** Parse a stored entry defensively — a malformed or half-written value is
 *  treated as nothing known, never as a zero count. */
export function parseStoredRoster(raw: string | null): RosterCount | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<RosterCount>;
    if (typeof j?.total !== "number" || typeof j?.checkedIn !== "number") return null;
    if (typeof j?.atMs !== "number") return null;
    return { checkedIn: j.checkedIn, total: j.total, atMs: j.atMs, stale: false };
  } catch {
    return null;
  }
}
