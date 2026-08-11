import "server-only";

/**
 * Resolve the qualification board for a briefing room — LAZILY.
 *
 * Timing matters here, and it is the reason this is not computed at send time.
 * The group whose results the board announces is out on track WHILE the next
 * group watches its video: at the moment staff press send, that session has
 * often not finished, and its scores certainly have not landed. The board is not
 * due on screen for another five minutes or so (video + helmet board), and by
 * then the data is there. So we resolve on the FULL feed poll (15s) and the
 * freshest answer is simply present by the time the timeline reaches it.
 *
 * CACHED IN REDIS, 60 SECONDS. Two briefing screens polling every 15s would
 * otherwise mean eight upstream Pandora calls a minute for a board that changes
 * once a heat. Same posture as /api/track-status: cache the expensive read, serve
 * stale rather than blocking, and never let an upstream failure reach the wall.
 *
 * FAILS TO NULL, ALWAYS. No qualifiers is a legitimate, designed state (a heat
 * where nobody levelled up, or a session whose scores are not in yet) and the
 * board says so gracefully. There is no path here that can put an error on a TV.
 */
import redis from "@/lib/redis";
import { previousTimelineAssignment } from "./assignments-db";
import { qualifiersFromScores, type SessionScoreRow } from "./quals";
import type { BriefingQualsBoard, BriefingRoom } from "./types";

const CACHE_TTL_SECONDS = 60;

/**
 * How long a "scores are not in yet" answer is remembered.
 *
 * Much shorter than a real answer, because the useful window is exactly the
 * minute or two after a heat finishes and we want the names as soon as they
 * land. But NOT zero: the control board polls every 5 seconds and the signage
 * admin page every 30, and between a session finishing and Pandora scoring it
 * there would otherwise be an uncached upstream call on every one of those polls,
 * each with a 4-second timeout. This bounds that to one call per room per 20s
 * while costing at most 20 seconds of delay on a board that is minutes away from
 * being shown.
 */
const NEGATIVE_TTL_SECONDS = 20;

/** Sentinel for a cached negative. A distinct marker rather than an empty board,
 *  because "no scores yet" and "scored, nobody qualified" must not be confused —
 *  the first should be retried soon, the second is the final answer. */
const NOT_YET = "not-yet";

const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

/** Pandora, via our own proxy — the same route /leagues and the level-up cron
 *  use, so score parsing lives in exactly one place. */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";

function cacheKey(venue: string, room: BriefingRoom, sessionId: string): string {
  return `briefing:quals:${venue}:${room}:${sessionId}`;
}

/**
 * The board this room should show in its quals phase, or null.
 *
 * `currentSessionId` is the session being briefed in the room right now; it is
 * EXCLUDED from the lookup so the board reports on the group before it — the one
 * that is out racing. Pass null when the room is idle (a `quals-only` send), in
 * which case the most recent briefed session is the subject.
 */
export async function resolveRoomQuals(args: {
  venue: string;
  businessDay: string;
  room: BriefingRoom;
  currentSessionId: string | null;
}): Promise<BriefingQualsBoard | null> {
  const { venue, businessDay, room, currentSessionId } = args;

  const previous = await previousTimelineAssignment(
    venue,
    businessDay,
    room,
    currentSessionId,
  ).catch(() => null);
  if (!previous) return null;

  const key = cacheKey(venue, room, previous.sessionId);

  try {
    const cached = await redis.get(key);
    if (cached === NOT_YET) return null;
    if (cached) {
      const parsed = JSON.parse(cached) as BriefingQualsBoard;
      if (parsed && Array.isArray(parsed.qualifiers)) return parsed;
    }
  } catch {
    /* a cache miss is just a slower path */
  }

  const scores = await fetchSessionScores(previous.sessionId);
  // Null means we could not ask, or the session has not been scored yet. Cached
  // only BRIEFLY — see NEGATIVE_TTL_SECONDS.
  if (scores === null || scores.length === 0) {
    try {
      await redis.set(key, NOT_YET, "EX", NEGATIVE_TTL_SECONDS);
    } catch {
      /* caching is an optimisation */
    }
    return null;
  }

  const board: BriefingQualsBoard = {
    heatNumber: previous.heatNumber,
    raceType: previous.raceType,
    qualifiers: qualifiersFromScores(scores, {
      track: previous.track,
      raceType: previous.raceType,
    }),
  };

  try {
    await redis.set(key, JSON.stringify(board), "EX", CACHE_TTL_SECONDS);
  } catch {
    /* caching is an optimisation */
  }

  return board;
}

/**
 * One session's scores from Pandora.
 *
 * Returns [] when the session ran but nobody scored, and null when we could not
 * ask at all — the caller treats those differently (see above).
 *
 * NO parseWithRawIds HERE, and that is a considered choice rather than an
 * oversight: this response carries `persId`, but we read only `name` and
 * `bestLap` off it, use `persId` as an opaque dedupe key with no arithmetic, and
 * never write any of it back upstream. The precision rule exists to stop a
 * rounded id being sent to BMI as an identity; nothing here has an id-shaped
 * output. (The existing /api/leagues consumers parse this same payload the same
 * way.)
 */
async function fetchSessionScores(sessionId: string): Promise<SessionScoreRow[] | null> {
  try {
    const url =
      `${SITE_URL}/api/leagues?action=scores&location=${FASTTRAX_LOCATION_ID}` +
      `&sessionId=${encodeURIComponent(sessionId)}`;
    const controller = new AbortController();
    // Pandora has been observed taking 20-40s when overloaded. A briefing board
    // is on a 15-second poll and has a designed empty state, so a slow upstream
    // must lose the race, not hold the feed.
    const timeout = setTimeout(() => controller.abort(), 4_000);
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    // The proxy hands back either the raw array or a { data: [...] } envelope
    // depending on the upstream shape — accept both, like the level-up cron.
    if (Array.isArray(json)) return json as SessionScoreRow[];
    const data = (json as { data?: unknown })?.data;
    return Array.isArray(data) ? (data as SessionScoreRow[]) : [];
  } catch {
    return null;
  }
}
