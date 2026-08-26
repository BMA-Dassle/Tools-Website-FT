import "server-only";

/**
 * The pit board's FAST roster — participants are "basically real time"
 * (owner 2026-08-13), so the lean slice of the roster (who, checked in,
 * grid position, name) rides the 2-second pulse instead of waiting out the
 * 15-second feed.
 *
 * THE PULSE IS REDIS-ONLY BY DISCIPLINE, and this module is the one measured
 * exception: the roster lives in Pandora and nowhere else, so somebody has
 * to ask. The cost is bounded the same way cameraReturn bounds its rebuild —
 * a short per-session Redis cache plus an NX rebuild claim — so however many
 * screens pulse however often, Pandora sees AT MOST ONE roster read per
 * session per CACHE_TTL_SECONDS, venue-wide. Every other pulse is one GET.
 *
 * A racer's card therefore updates within ~2s (pulse) + ~4s (cache age) of
 * the desk making a change — add, check-in, or a BMI re-grid.
 */
import redis from "@/lib/redis";
import { participantCheckedIn } from "../checkin-progress";
import { sessionRoster } from "../service/checkin-progress";
import type { TrackKey } from "../track";
import { readBriefingRooms } from "../briefing/state.server";
import { briefingTimelineAt } from "../briefing/phase";
import { HELMET_PHASE_MS } from "../briefing/types";
import { pitDisplaySession } from "./service";
import { pitCardName } from "./pit-board";
import type { FastPitRoster, FastPitRow, PitParticipantRow } from "./pit-board";

/** How stale the fast roster may be. With the 2s pulse on top, the wall
 *  tracks the desk within ~2–6 seconds. */
const CACHE_TTL_SECONDS = 4;
/** The rebuild claim — slightly under the TTL so a crashed rebuild can never
 *  lock the cache out for longer than one stale window. */
const CLAIM_TTL_SECONDS = 3;

const PIT_TRACKS: TrackKey[] = ["blue", "red", "mega"];

/**
 * How long after the helmet board is due we keep pre-warming a room's roster.
 *
 * The helmet phase no longer ends on a clock (phase.ts), so a room nobody moved
 * on stays in it all night — pre-warming on the phase alone would keep asking
 * Pandora about a group that went home hours ago. Ten minutes covers every real
 * gap between the film finishing and the press, and expires quietly otherwise.
 */
const PREWARM_WINDOW_MS = 10 * 60_000;

/**
 * WHOSE ROSTER TO HAVE READY BEFORE IT IS ASKED FOR (owner 2026-08-14: "could
 * you load that roster while they're in helmeting and have it ready?").
 *
 * The pit board takes its session from the lane, so at the instant of the press
 * the board asks about a session nothing has cached and pays for a Pandora read
 * inside a 2-second pulse. Warming from the moment the film ends means the cache
 * is already hot when the press lands and the names appear with the rail.
 *
 * THIS DOES NOT MAKE ANYTHING STALER, which is the owner's other requirement —
 * "we cannot get into a situation where it doesn't update when we need to make
 * changes, needs to be instant". The cache TTL is untouched at 4 seconds; this
 * only adds a session to the set being refreshed at that same rate, EARLIER. A
 * grid change made during helmeting therefore shows up faster than before, not
 * slower.
 */
async function preWarmSessions(nowMs: number): Promise<string[]> {
  try {
    const rooms = await readBriefingRooms("FT");
    const out: string[] = [];
    for (const state of Object.values(rooms)) {
      if (!state?.sessionId) continue;
      const t = briefingTimelineAt(state, nowMs);
      if (t.phase !== "helmet") continue;
      const since = nowMs - state.triggeredAtMs;
      if (since > t.videoMs + HELMET_PHASE_MS + PREWARM_WINDOW_MS) continue;
      out.push(state.sessionId);
    }
    return out;
  } catch {
    return [];
  }
}

function cacheKey(sessionId: string): string {
  return `pit:fast-roster:${sessionId}`;
}

function claimKey(sessionId: string): string {
  return `pit:fast-roster:claim:${sessionId}`;
}

function toFastRows(rows: PitParticipantRow[]): FastPitRow[] {
  return rows.map((r) => ({
    participantId: r.participantId == null ? null : String(r.participantId),
    personId: r.personId == null ? "" : String(r.personId),
    name: pitCardName(r),
    // Verbatim shape (timestamp string / true / null) so the client-side merge
    // can feed it straight back through orderPitRoster.
    checkedIn: participantCheckedIn(r)
      ? typeof r.checkedIn === "string"
        ? r.checkedIn
        : true
      : null,
    startPosition:
      typeof r.raceInfo?.startPosition === "number" && Number.isFinite(r.raceInfo.startPosition)
        ? r.raceInfo.startPosition
        : null,
  }));
}

/** One session's fast roster: cache first, one claimed rebuild on a miss.
 *  Null when nothing is readable yet — the wall keeps its last merge. */
async function fastRoster(sessionId: string, nowMs: number): Promise<FastPitRoster | null> {
  try {
    const cached = await redis.get(cacheKey(sessionId));
    if (cached) return { sessionId, rows: JSON.parse(cached) as FastPitRow[] };
  } catch {
    /* fall through — a broken cache entry must not stop the rebuild */
  }

  // ONE lambda rebuilds; everyone else keeps last pulse's picture and reads
  // the fresh cache on the next beat. Without the claim, six screens pulsing
  // at 2s would each hit Pandora on the same cold miss.
  const claimed = await redis
    .set(claimKey(sessionId), "1", "EX", CLAIM_TTL_SECONDS, "NX")
    .catch(() => null);
  if (claimed !== "OK") return null;

  // A tighter memo bound than the feed's 12s — a rebuild that served a
  // 12s-old memo would defeat the 4s cache it is refilling.
  const rows = (await sessionRoster(sessionId, nowMs, 3_000).catch(() => null)) as
    | PitParticipantRow[]
    | null;
  if (!rows) return null;
  const fast = toFastRows(rows);
  try {
    await redis.set(cacheKey(sessionId), JSON.stringify(fast), "EX", CACHE_TTL_SECONDS);
  } catch {
    /* the caller still gets this build's rows */
  }
  return { sessionId, rows: fast };
}

/**
 * WARM ONE SESSION'S ROSTER NOW, ahead of the pulse that will want it.
 *
 * WHY (owner 2026-08-14: "I need those names to pop right after they hit send
 * to holding"). The pit board picks its session straight off the lane, so the
 * moment the press lands the board is asking about a session nobody has cached
 * yet. That cold miss is paid INSIDE a pulse: the first screen to ask wins the
 * rebuild claim and waits on Pandora before it can answer, so the cards arrive
 * a pulse or two after the rail already moved — the few seconds the owner saw.
 *
 * Called from the press itself (after the response, never in front of it), this
 * puts the roster in Redis before the next 2-second beat asks, so the names land
 * with the rail instead of behind it.
 *
 * Deliberately IGNORES the rebuild claim: the claim exists to stop many screens
 * stampeding Pandora on one cold miss, and this is exactly one caller at a known
 * moment. It still writes the same cache entry, so the pulse path is unchanged.
 */
export async function primeFastRoster(sessionId: string, nowMs: number): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const rows = (await sessionRoster(sessionId, nowMs, 0).catch(() => null)) as
      | PitParticipantRow[]
      | null;
    if (!rows) return false;
    await redis.set(cacheKey(sessionId), JSON.stringify(toFastRows(rows)), "EX", CACHE_TTL_SECONDS);
    return true;
  } catch {
    // The pulse's own cold-miss rebuild is still there behind this — a failed
    // warm costs the couple of seconds it was trying to save, nothing more.
    return false;
  }
}

/** Every track's fast roster, for the pulse. Tracks sharing a session on a
 *  Mega day share one cache entry — the map just points both at it. */
export async function readFastPitRosters(
  nowMs: number,
): Promise<Record<TrackKey, FastPitRoster | null>> {
  const out: Record<TrackKey, FastPitRoster | null> = { blue: null, red: null, mega: null };
  try {
    const [sessions, warm] = await Promise.all([
      Promise.all(PIT_TRACKS.map((t) => pitDisplaySession(t))),
      preWarmSessions(nowMs),
    ]);
    const bySession = new Map<string, FastPitRoster | null>();
    // Displayed sessions AND the ones about to be — same 4s cache, same claim,
    // so a warm costs no more than the session it is getting ahead of.
    const wanted = new Set<string>([
      ...sessions.filter(Boolean).map((s) => (s as { sessionId: string }).sessionId),
      ...warm,
    ]);
    await Promise.all(
      Array.from(wanted).map(async (sid) => {
        bySession.set(sid, await fastRoster(sid, nowMs));
      }),
    );
    PIT_TRACKS.forEach((track, i) => {
      const s = sessions[i];
      out[track] = s ? (bySession.get(s.sessionId) ?? null) : null;
    });
    return out;
  } catch {
    return out;
  }
}
