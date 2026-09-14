import "server-only";

/**
 * WHO THE PORTAL HAS ON TRACK OPS RIGHT NOW.
 *
 * The HeadPinz portal owns the schedule: it holds the 7shifts shifts, the
 * punches and the pit board's own position assignments. We own the races. The
 * Track Ops list on our boards is the intersection — the portal's current
 * holders of Track Ops and Track Ops Floaters, plus anyone our own floor says
 * is hosting a group (owner 2026-09-07). Membership and state are decided in
 * ONE place, crew-list.ts; this module only fetches and normalises.
 *
 * PRESENCE COMES FROM HERE, NEVER FROM US. A pill that said "on break" while
 * the pit board two rooms away said "in" would be a second opinion about a fact
 * the portal owns, and staff would learn to trust neither. So `presence` and
 * `hasPunchedToday` travel verbatim.
 *
 * WHAT A FAILURE MEANS. A 404 is the endpoint not existing yet (it is being
 * built in parallel), a timeout is the portal being slow. Neither is an error
 * here and neither may empty the board: an empty array would read as "nobody is
 * on shift", which is a claim, and a false one. A failed read returns the LAST
 * GOOD roster for up to ten minutes — a shift assignment is stable for hours,
 * so yesterday's answer from nine minutes ago is very nearly today's — and only
 * then `null`, which the fold renders as the race hosts alone plus a dim
 * "roster unavailable" note.
 *
 * CACHED IN MODULE MEMORY, INCLUDING FAILURES, AND SERVED STALE WHILE IT
 * REFRESHES. The check-in board and the tablets poll every two seconds and up
 * to nineteen TVs pulse at the same rate; without a cache this one cross-service
 * GET would be the busiest thing any of them does. Caching the FAILURE matters
 * as much as caching the success: without it, a portal that is down puts the
 * full five-second timeout in front of every single poll. And serving STALE
 * matters as much as either (2026-09-12): the poll that landed the instant the
 * cache expired used to pay the read itself — a five-second stall on a two-
 * second lane, once every thirty seconds, for as long as the portal was slow.
 * Now the last answer is handed back at once and the refresh runs behind the
 * response (~/lib/helpers/swr-cache). Only the very first read of an isolate
 * waits, because there is nothing yet to serve.
 */
import { businessDayYmdAtRolloverET } from "@/lib/race-business-day";
import { PORTAL_ORIGIN, PORTAL_PIT_BOARD_LOCATION_ID } from "~/lib/constants/admin-tools";
import { createSwrCache } from "~/lib/helpers/swr-cache";
import { afterResponse } from "~/features/signage/after-response.server";

/** The portal's business day rolls at 5 AM ET; the racing day rolls at 2. */
const PORTAL_DAY_ROLLOVER_HOUR = 5;

/** How long a good answer stands before we ask again. */
const CACHE_MS = 30_000;
/**
 * How long a good answer may still be SERVED past that while reads keep failing.
 *
 * Ten minutes because a Track Ops assignment lasts hours and a break lasts
 * fifteen minutes: past ten, the presence dots would be describing a floor that
 * has moved on, and no list is more honest than a confident stale one.
 */
const LAST_GOOD_MS = 10 * 60_000;
/** A slow portal must not become a slow television. */
const TIMEOUT_MS = 5_000;

/** The two positions whose holders are "Track Ops" for our purposes. */
const TRACK_OPS_SLOTS: ReadonlyArray<{ group: string; slot: string }> = [
  { group: "track_ops", slot: "Track Ops" },
  { group: "floaters", slot: "Track Ops Floaters" },
];

export type CrewPresence = "in" | "break" | "out";

/** One person the portal currently has on Track Ops. */
export interface TrackOpsHolder {
  /** 7shifts USER id — the key every surface joins on. */
  userId: number;
  firstName: string;
  /** The portal's word, never ours. */
  presence: CrewPresence;
  /** Have they punched in at all today? An `out` with no punch has not arrived
   *  yet; an `out` WITH one has gone home, and goes off the board. */
  hasPunchedToday: boolean;
}

/** The portal's business day (5 AM ET rollover) — the day to ask it about. */
export function portalBusinessDayYmdET(now: Date = new Date()): string {
  return businessDayYmdAtRolloverET(PORTAL_DAY_ROLLOVER_HOUR, now);
}

interface PortalHolder {
  userId?: unknown;
  firstName?: unknown;
  name?: unknown;
  presence?: unknown;
  hasPunchedToday?: unknown;
}
interface PortalPosition {
  group?: unknown;
  slot?: unknown;
  holders?: unknown;
}

function parsePresence(raw: unknown): CrewPresence {
  return raw === "in" || raw === "break" ? raw : "out";
}

/** First name from whatever the row carries — `firstName`, else the leading
 *  word of `name` ("Pedro M." → "Pedro"). A row with neither is dropped. */
function firstNameOf(h: PortalHolder): string | null {
  if (typeof h.firstName === "string" && h.firstName.trim()) return h.firstName.trim();
  if (typeof h.name === "string" && h.name.trim()) return h.name.trim().split(/\s+/)[0];
  return null;
}

function parseRoster(json: unknown): TrackOpsHolder[] {
  const positions = (json as { data?: { positions?: unknown } })?.data?.positions;
  if (!Array.isArray(positions)) return [];
  const byUser = new Map<number, TrackOpsHolder>();
  for (const raw of positions as PortalPosition[]) {
    const wanted = TRACK_OPS_SLOTS.some((s) => s.group === raw?.group && s.slot === raw?.slot);
    if (!wanted || !Array.isArray(raw.holders)) continue;
    for (const h of raw.holders as PortalHolder[]) {
      // A 7shifts user id, not a BMI id — safe to Number(), nine orders of
      // magnitude short of MAX_SAFE_INTEGER (see the house rule).
      const userId = typeof h?.userId === "number" ? h.userId : Number(h?.userId);
      const firstName = firstNameOf(h ?? {});
      if (!Number.isFinite(userId) || userId <= 0 || !firstName) continue;
      // Somebody rostered on both Track Ops and the floaters is one person.
      if (byUser.has(userId)) continue;
      byUser.set(userId, {
        userId,
        firstName,
        presence: parsePresence(h.presence),
        hasPunchedToday: h.hasPunchedToday === true,
      });
    }
  }
  return [...byUser.values()];
}

/** The one read behind the cache: the portal's answer, parsed, or a throw. */
async function loadRoster(date: string): Promise<TrackOpsHolder[]> {
  const url = `${PORTAL_ORIGIN}/api/schedule/pit-board-now?date=${encodeURIComponent(date)}&locationId=${PORTAL_PIT_BOARD_LOCATION_ID}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 404 = not built yet. Same handling as any other failure, and deliberately
  // not louder: this endpoint is expected to be missing for a while.
  if (!res.ok) throw new Error(`portal ${res.status}`);
  return parseRoster(await res.json());
}

/**
 * Keyed by the portal's business day, so the roster rolls over with it rather
 * than serving last night's crew for thirty seconds after 5 AM. A failed read
 * is remembered for CACHE_MS — one attempt per window, however many boards poll.
 */
const rosterCache = createSwrCache<TrackOpsHolder[]>({
  ttlMs: CACHE_MS,
  maxStaleMs: LAST_GOOD_MS,
  retryAfterMs: CACHE_MS,
  load: loadRoster,
  schedule: afterResponse,
});

/**
 * The portal's current Track Ops crew, or `null` when it cannot be reached and
 * no recent answer survives.
 *
 * NEVER SLOWER THAN A CACHE HIT once an isolate has read the roster once: a
 * stale answer is served and refreshed behind the response. See the header.
 *
 * @param date the PORTAL's business day (`portalBusinessDayYmdET`), not ours.
 */
export async function fetchPortalTrackOpsNow(
  date: string = portalBusinessDayYmdET(),
): Promise<TrackOpsHolder[] | null> {
  try {
    return await rosterCache.read(date);
  } catch {
    return null;
  }
}

/** Test seam: drop the cache. Never called in production. */
export function __resetPortalRosterCache(): void {
  rosterCache.reset();
}
