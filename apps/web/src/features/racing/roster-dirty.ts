/**
 * WHICH SESSIONS THE VENUE JUST SAID SOMETHING ABOUT — the pure half.
 *
 * `pre-race-tickets` re-reads every roster in its window every two minutes to
 * notice a racer who was added, and almost every one of those reads returns
 * exactly what it returned last time. Measured over 88,280 webhook invocations
 * (2026-08-17→19), the venue mentions a MEDIAN OF ZERO sessions per two-minute
 * tick (mean 0.58, p90 2, p99 5, max 16). So the wire can answer "did anything
 * happen here?" for free, and the cron only has to pay Pandora for the sessions
 * where the answer is yes.
 *
 * WHAT COUNTS AS A TOUCH, and why these five types:
 *
 *   RaceAdvice / RaceStop                  carry `Drivers[]` — the roster itself
 *   EnterTapNotification                   a racer tapping into the pit area
 *   ParticipantDidNotStartNotification     a racer scratched at the flag
 *   SessionFullNotification                carries `ParticipantsCount`
 *
 * `AssignmentNotification` is deliberately ABSENT even though it is
 * participant-level: it carries `ParticipantId` and a kart, but **no
 * `SessionId`**, so there is nothing to mark dirty without a lookup we do not
 * have here. Resolving it would mean holding a participant→session map on the
 * webhook's hot path to save a fraction of a read per tick. Not worth it — an
 * assignment is nearly always accompanied by wire traffic that DOES name the
 * session.
 *
 * DELIBERATELY NOT CHANGE-DETECTING. This reports every session the wire
 * mentioned, not every session whose roster actually moved, because telling
 * those apart means storing the previous roster and diffing it on the hot path.
 * The measurement above is already the "mentioned" number, and it is small
 * enough that the extra precision buys nothing. A session mentioned but
 * unchanged costs exactly one Pandora read.
 */

/** Every session id this message says something about. Deduped, order stable. */
export function rosterTouchedSessionIds(message: unknown): string[] {
  const records = Array.isArray(message) ? message : [message];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const type = r["$type"];
    let raw: unknown;
    switch (type) {
      case "RaceAdvice":
      case "RaceStop":
        raw = r.RaceId;
        break;
      case "EnterTapNotification":
      case "ParticipantDidNotStartNotification":
      case "SessionFullNotification":
        raw = r.SessionId;
        break;
      default:
        continue;
    }
    if (raw === undefined || raw === null) continue;
    // String, always — the same id space as Pandora session ids, which the
    // house rule never round-trips through Number (see venue-broadcast.ts).
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Beyond this, the bridge is not feeding us and silence proves nothing.
 *
 * Mirrors `BRIDGE_STALE_MS` in races-current-warm, deliberately and with the
 * same reasoning: the venue sends BcTime every ~30s even on a dead-quiet night,
 * so 2 minutes is ~4 missed heartbeats — long enough not to flap, short enough
 * to cover one heat. A half-open socket looks exactly like a quiet venue from
 * in here, which on 8/17 15:07-15:19 hid four called heats behind an ingest
 * buffer holding zero frames of any kind.
 */
export const BRIDGE_STALE_MS = 120_000;

/**
 * The net, per session — how long we will go without reading a roster even if
 * the wire says nothing at all.
 *
 * Two tiers, because the cost of being late is not uniform. A heat about to run
 * has a roster that is about to matter on a wall and at a desk, so a frame the
 * bridge dropped there is felt within minutes; further out, it is not.
 * Neither number is a freshness guarantee — the wire is what makes this fast,
 * and the net is only there so a dropped frame costs minutes rather than
 * forever.
 */
export const NET_NEAR_MS = 10 * 60_000;
/**
 * The far net is deliberately LONG, because it is almost redundant: a heat
 * beyond the near horizon only has to be right by the time it CROSSES it, and
 * crossing re-tiers the heat to `NET_NEAR_MS`, whose clock is already hours
 * expired. So the first tick inside the horizon reads it anyway.
 * This is only a backstop against a heat that somehow sits far out all day.
 *
 * It was 30 minutes and that was measurably wrong: simulated against the real
 * wire it cost ~5,400 reads a day, more than the whole thing was saving.
 */
export const NET_FAR_MS = 4 * 60 * 60_000;

export interface RosterReadInput {
  nowMs: number;
  /** Scheduled start, ms. Null when unparseable — treated as near, never skipped
   *  on a guess. */
  scheduledStartMs: number | null;
  /** The near horizon: now + 2h. Heats scheduled inside it get the tighter net.
   *  Purely a read-budget boundary — since 2026-08-19 it gates no message. */
  nearHorizonMs: number;
  /** The wire's touch counter for this session right now; null = key absent. */
  dirtyCounter: number | null;
  /** The counter we had already read past, from our own last read; null = we
   *  have never read this session. */
  readCounter: number | null;
  /** When we last read this roster from Pandora, ms; null = never. */
  lastReadMs: number | null;
  /** The bridge heartbeat, ms; null/NaN = no heartbeat at all. */
  bridgeLastEventMs: number | null;
}

export type RosterReadReason =
  | "never-read"
  | "bridge-stale"
  | "bridge-stale-far"
  | "wire-touched"
  | "net-due"
  | "quiet";

/**
 * Should this session's roster be read from Pandora on this tick? PURE, so the
 * whole rule is testable without a clock, a socket or an upstream.
 *
 * The order of these checks is the safety argument:
 *
 *  1. Bridge stale → fall all the way back to what this cron did BEFORE the
 *     wire existed: read the near horizon every tick, and do not look
 *     beyond it. Both halves matter. Reading the near horizon is obvious — silence
 *     from a dead pipe is not evidence of a quiet venue, and that is the
 *     failure that actually happened (8/17 15:07-15:19, zero frames, four
 *     heats missed). NOT reading beyond it is the half that is easy to get
 *     wrong: the all-day scope is a WS FEATURE, and keeping it while the WS is
 *     down means reading every heat of the day on every tick. Simulated
 *     against the real wire that turned a saving into 8,098 reads/day against
 *     the old 2,516 — three times WORSE than the thing it replaced.
 *  2. Never read → read. A session we hold no roster for cannot be skipped on
 *     the grounds that nothing changed; nothing is exactly what we know about
 *     it. This is what makes widening to the whole day safe.
 *  3. Wire touched it since our last read → read.
 *  4. Net expired → read.
 *  5. Otherwise skip.
 */
export function planRosterRead(i: RosterReadInput): { read: boolean; reason: RosterReadReason } {
  const near =
    i.scheduledStartMs === null || !Number.isFinite(i.scheduledStartMs)
      ? true // unknown start — treat as near rather than skip on a guess
      : i.scheduledStartMs <= i.nearHorizonMs;

  const beat = i.bridgeLastEventMs;
  const bridgeAlive = beat !== null && Number.isFinite(beat) && i.nowMs - beat <= BRIDGE_STALE_MS;
  if (!bridgeAlive) {
    return near
      ? { read: true, reason: "bridge-stale" }
      : { read: false, reason: "bridge-stale-far" };
  }

  if (i.lastReadMs === null || i.readCounter === null) {
    return { read: true, reason: "never-read" };
  }

  // A counter that moved — or vanished and restarted, which an expired key does
  // — means the wire said something we have not accounted for.
  if ((dirtyCounterOrZero(i.dirtyCounter) ?? 0) !== i.readCounter) {
    return { read: true, reason: "wire-touched" };
  }

  const net = near ? NET_NEAR_MS : NET_FAR_MS;
  if (i.nowMs - i.lastReadMs >= net) return { read: true, reason: "net-due" };

  return { read: false, reason: "quiet" };
}

function dirtyCounterOrZero(v: number | null): number {
  return v === null || !Number.isFinite(v) ? 0 : v;
}
