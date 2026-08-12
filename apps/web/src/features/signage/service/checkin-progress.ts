import "server-only";

/**
 * How far the desk has got through the heats it currently has open, for a wall.
 *
 * WHY THIS READS PANDORA LIVE, when almost everything else in this feed reads
 * Redis. This number has to MOVE. A marshal watches it while a group is scanned
 * in one at a time, and the roster cache
 * (`pandora:participants:{loc}:{sid}:R1`) is warmed by the check-in-alerts cron
 * only until that heat has been alerted on — after which it sits frozen for its
 * 10-minute TTL while staff are still scanning. A frozen "6 of 14" on a wall is
 * worse than no number: it reads as a group that stopped arriving. The check-in
 * station itself calls Pandora every 5 seconds for exactly this reason.
 *
 * The cost is bounded three ways: at most three heats are ever open (blue, red,
 * mega), the counts are memoised per session for a poll interval so every screen
 * in the building shares one read, and the roster cache is still there as the
 * fallback when a live read fails.
 *
 * A HEAT WE CANNOT COUNT IS DROPPED, never shown as zero. See collect().
 */
import redis from "@/lib/redis";
import { parseWithRawIds } from "@ft/db";
import {
  checkingInTracks,
  countCheckedIn,
  type CalledRaceRecord,
  type CheckinProgressSession,
  type CheckinRosterRow,
} from "../checkin-progress";
import type { TrackKey } from "../track";

/** Pandora location id for FastTrax — the only venue with tracks. */
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";

/**
 * How long a session's counts may be reused.
 *
 * Just under the TV feed's own 15s poll, so a screen gets a fresh count on
 * essentially every poll while several screens landing on the same warm lambda
 * still share one Pandora read. Failures are memoised for the same window so a
 * degraded upstream cannot be hammered by a wall of TVs.
 */
const COUNT_TTL_MS = 12_000;
/** Drop memo entries older than this so a lambda alive all night cannot grow. */
const COUNT_PRUNE_MS = 10 * 60_000;

type Counts = { checkedIn: number; total: number };

const countCache = new Map<string, { at: number; value: Counts | null }>();

function pruneCounts(nowMs: number): void {
  for (const [key, entry] of countCache) {
    if (nowMs - entry.at > COUNT_PRUNE_MS) countCache.delete(key);
  }
}

/** The three stored races-current entries, in one round trip. */
async function calledRaces(): Promise<Partial<Record<TrackKey, CalledRaceRecord | null>>> {
  const tracks: TrackKey[] = ["blue", "red", "mega"];
  const out: Partial<Record<TrackKey, CalledRaceRecord | null>> = {};
  try {
    const raw = await redis.mget(...tracks.map((t) => `pandora:last-race:fasttrax:${t}`));
    tracks.forEach((track, i) => {
      const value = raw[i];
      if (!value) return;
      try {
        out[track] = JSON.parse(value) as CalledRaceRecord;
      } catch {
        /* one malformed entry must not cost the other two tracks */
      }
    });
  } catch {
    /* Redis down — no board, rather than a wrong board */
  }
  return out;
}

/**
 * The roster, live from Pandora.
 *
 * `parseWithRawIds` rather than `res.json()`: the payload carries personId and
 * participantId, and the house rule is that no response carrying a BMI id is
 * ever handed to the standard parser — a 17-digit id is silently rounded, and
 * the next person to reach into this payload for an id would inherit the bug
 * with no sign anything was wrong.
 */
async function liveRoster(sessionId: string): Promise<CheckinRosterRow[] | null> {
  if (!PANDORA_KEY) return null;
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/session/${FASTTRAX_LOCATION_ID}/${sessionId}/participants?excludeRemoved=true`,
      {
        headers: { Authorization: `Bearer ${PANDORA_KEY}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!res.ok) return null;
    const json = parseWithRawIds<{ data?: CheckinRosterRow[] }>(await res.text());
    return Array.isArray(json?.data) ? json.data : null;
  } catch {
    return null;
  }
}

/** The cron-warmed roster — stale by up to its TTL, but real. */
async function cachedRoster(sessionId: string): Promise<CheckinRosterRow[] | null> {
  try {
    const raw = await redis.get(`pandora:participants:${FASTTRAX_LOCATION_ID}:${sessionId}:R1`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CheckinRosterRow[]) : null;
  } catch {
    return null;
  }
}

/**
 * Progress through ONE session's roster, live, memoised.
 *
 * Exported because the track check-in boards need exactly this number for
 * exactly the same heat (see ./race-checkin). Two boards in one building
 * counting the same group from two different sources is how a marshal and a
 * desk attendant end up arguing about who is missing — so there is one counter,
 * one cache, and one answer.
 *
 * Null when the roster could not be read at all; the caller shows no count.
 */
export async function sessionCheckinCounts(
  sessionId: string,
  nowMs: number,
): Promise<Counts | null> {
  const memo = countCache.get(sessionId);
  if (memo && nowMs - memo.at < COUNT_TTL_MS) return memo.value;

  const roster = (await liveRoster(sessionId)) ?? (await cachedRoster(sessionId));
  const value = roster ? countCheckedIn(roster) : null;
  countCache.set(sessionId, { at: nowMs, value });
  pruneCounts(nowMs);
  return value;
}

/**
 * Every heat the check-in station currently has open, with its progress.
 *
 * Empty array when nothing is checking in — the boards then show no rail at all,
 * which is the honest answer between heats.
 *
 * A heat whose roster could not be read is DROPPED rather than reported as
 * "0 of 0". The whole point of the number is that a marshal can act on it; a
 * fabricated zero would send someone to the desk looking for a group that is
 * already standing in their room.
 */
export async function checkinProgress(nowMs: number): Promise<CheckinProgressSession[]> {
  const open = checkingInTracks(await calledRaces(), nowMs);
  if (open.length === 0) return [];

  const rows = await Promise.all(
    open.map(async (heat) => {
      const counts = await sessionCheckinCounts(heat.sessionId, nowMs);
      if (!counts || counts.total === 0) return null;
      return { ...heat, checkedIn: counts.checkedIn, total: counts.total };
    }),
  );
  return rows.filter((r): r is CheckinProgressSession => r !== null);
}
