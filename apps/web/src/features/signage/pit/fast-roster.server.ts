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
import { pitDisplaySession } from "./service";
import type { FastPitRoster, FastPitRow, PitParticipantRow } from "./pit-board";

/** How stale the fast roster may be. With the 2s pulse on top, the wall
 *  tracks the desk within ~2–6 seconds. */
const CACHE_TTL_SECONDS = 4;
/** The rebuild claim — slightly under the TTL so a crashed rebuild can never
 *  lock the cache out for longer than one stale window. */
const CLAIM_TTL_SECONDS = 3;

const PIT_TRACKS: TrackKey[] = ["blue", "red", "mega"];

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
    name: [r.firstName ?? "", r.lastName ?? ""].join(" ").trim() || "Racer",
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

/** Every track's fast roster, for the pulse. Tracks sharing a session on a
 *  Mega day share one cache entry — the map just points both at it. */
export async function readFastPitRosters(
  nowMs: number,
): Promise<Record<TrackKey, FastPitRoster | null>> {
  const out: Record<TrackKey, FastPitRoster | null> = { blue: null, red: null, mega: null };
  try {
    const sessions = await Promise.all(PIT_TRACKS.map((t) => pitDisplaySession(t)));
    const bySession = new Map<string, FastPitRoster | null>();
    await Promise.all(
      Array.from(
        new Set(sessions.filter(Boolean).map((s) => (s as { sessionId: string }).sessionId)),
      ).map(async (sid) => {
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
