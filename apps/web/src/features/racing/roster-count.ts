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
 * The same question, asked of the venue's own broadcast instead of a clock.
 *
 * `ROSTER_FRESH_MS` is a GUESS — ten seconds is how long we are willing to be
 * wrong for, and every tick past it buys a Pandora read whether or not anything
 * moved. Almost nothing moves: measured over 88,280 webhook invocations
 * (2026-08-17→19), the venue mentions a median of ZERO sessions per two-minute
 * tick. So while the wire is alive and silent about a session, its count is not
 * ten seconds old — it is CURRENT, and re-reading it proves nothing.
 *
 * This stretches the no-read window to `ROSTER_WIRE_FRESH_MS`, and collapses it
 * to zero the instant the wire says the session moved. Faster than today when
 * something happens, far cheaper when nothing does.
 *
 * IT NEVER MAKES THE ANSWER STALER THAN A HUMAN CAN NOTICE, because the count a
 * desk actually watches is floored by our own scan ledger (`applyLocalFloor`) —
 * that is not upstream data and does not wait for any of this. What the wire
 * gates is only the OTHER half: racers added, removed, or checked in directly
 * in BMI rather than through our scanner.
 */
export const ROSTER_WIRE_FRESH_MS = 60_000;

export interface WireFreshnessInput {
  entry: RosterCount | null;
  nowMs: number;
  /** The venue's touch counter for this session; null = no mark at all. */
  dirtyCounter: number | null;
  /** The counter this consumer had already read past; null = never banked. */
  readCounter: number | null;
  /** Heartbeat age gate, decided by the caller. */
  bridgeAlive: boolean;
}

/**
 * May we serve the stored count without asking Pandora?
 *
 * Yes when it is inside the plain clock window (unchanged behaviour), OR when
 * the wire is alive and has said nothing about this session since we banked it
 * and the count is still inside the longer wire window.
 *
 * DEGRADES TO EXACTLY TODAY'S BEHAVIOUR when the marks are absent — no bridge,
 * no webhook writer deployed, Redis unreachable, a session the venue has never
 * mentioned. All of those land on `ROSTER_FRESH_MS` and the ten-second re-read,
 * which is why this is safe to ship before anything starts writing the marks.
 */
export function rosterIsFreshForWire(i: WireFreshnessInput): boolean {
  if (rosterIsFresh(i.entry, i.nowMs)) return true;
  if (!i.bridgeAlive) return false;
  // Never banked, or the counter moved (including a key that expired and
  // restarted below us) — the wire is telling us something we have not read.
  if (i.readCounter === null) return false;
  if ((i.dirtyCounter ?? 0) !== i.readCounter) return false;
  const e = i.entry;
  if (!e || e.atMs === null || e.total === null) return false;
  const age = i.nowMs - e.atMs;
  if (age < 0) return false; // clock skew — re-read rather than trust it
  return age < ROSTER_WIRE_FRESH_MS;
}

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

/** What we ourselves scanned into one session, as the check-in POST reports it
 *  back to the board that asked for the check-in. */
export interface OwnScanCredit {
  locationId: string;
  sessionId: string | number;
  /** Size of our scan ledger for that session, including the racer just done. */
  count: number;
}

/** The shape of a strip row this floor can be applied to. Structural on
 *  purpose — the board's own row type carries a good deal more than this. */
export interface FlooredRow {
  sessionId: string | number;
  locationId?: string;
  checkedIn: number | null;
  total: number | null;
  stale?: boolean;
}

/**
 * THE BOARD CREDITS ITS OWN SCAN IMMEDIATELY, instead of waiting to rediscover
 * it on the next poll.
 *
 * The desk polls its strip every 15 seconds, which is fine for learning what
 * OTHER stations and BMI have been doing and absurd for learning what this
 * station did a moment ago: a group scanning through went four, four, four,
 * four, six. The check-in response now carries our ledger back, and this puts
 * it straight onto the row it belongs to.
 *
 * MATCHED ON BOTH IDS. FT/HP-FM and Naples are separate BMI servers and can
 * mint numerically identical session ids, so a session id alone is not a row
 * identity. A row carrying no locationId — one served by an instance from
 * before this shipped — matches on session alone rather than being skipped:
 * failing open costs a rare over-credit on a collision, failing closed costs
 * the whole feature for as long as a stale row is in play.
 *
 * Rows are returned by identity when nothing changed, so React does not
 * re-render a strip that did not move.
 */
export function applyOwnScanCredit<T extends FlooredRow>(rows: T[], own: OwnScanCredit): T[] {
  if (!own.count) return rows;
  return rows.map((row) => {
    if (String(row.sessionId) !== String(own.sessionId)) return row;
    if (row.locationId && row.locationId !== own.locationId) return row;
    const floored = applyLocalFloor(
      { checkedIn: row.checkedIn, total: row.total, atMs: null, stale: !!row.stale },
      own.count,
    );
    return floored.checkedIn === row.checkedIn ? row : { ...row, checkedIn: floored.checkedIn };
  });
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
