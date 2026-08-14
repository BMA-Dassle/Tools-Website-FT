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
import { sessionBriefed } from "../briefing/state.server";
import {
  checkingInTracks,
  countCheckedIn,
  participantCheckedIn,
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
 * How long a session's roster may be reused.
 *
 * Just under the TV feed's own 15s poll, so a screen gets a fresh read on
 * essentially every poll while several screens landing on the same warm lambda
 * still share one Pandora read. Failures are memoised for the same window so a
 * degraded upstream cannot be hammered by a wall of TVs.
 */
const COUNT_TTL_MS = 12_000;
/** Drop memo entries older than this so a lambda alive all night cannot grow. */
const COUNT_PRUNE_MS = 10 * 60_000;

type Counts = { checkedIn: number; total: number };

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
 * THE ROSTER ITSELF, live-first and memoised — the ONE Pandora read behind
 * everything roster-shaped on the walls: the pit board's cards (names,
 * check-in stamps, personIds, viewpoint credits), the counts below, and the
 * photo route's membership check all fold from the same rows.
 *
 * One memo, deliberately. The counts used to keep their own cache of the same
 * fetch, which meant a pit board paid Pandora TWICE per poll for one roster —
 * a count is arithmetic over rows already in hand, not a second read. Failures
 * are memoised too, so a degraded Pandora is not hammered by a wall of TVs.
 */
const rosterCache = new Map<string, { at: number; value: CheckinRosterRow[] | null }>();

export async function sessionRoster(
  sessionId: string,
  nowMs: number,
): Promise<CheckinRosterRow[] | null> {
  const memo = rosterCache.get(sessionId);
  if (memo && nowMs - memo.at < COUNT_TTL_MS) return memo.value;

  const roster = (await liveRoster(sessionId)) ?? (await cachedRoster(sessionId));
  rosterCache.set(sessionId, { at: nowMs, value: roster });
  for (const [key, entry] of rosterCache) {
    if (nowMs - entry.at > COUNT_PRUNE_MS) rosterCache.delete(key);
  }
  return roster;
}

/**
 * Progress through ONE session's roster — arithmetic over sessionRoster's
 * memoised rows, never a separate fetch.
 *
 * Exported because the track check-in boards need exactly this number for
 * exactly the same heat (see ./race-checkin). Two boards in one building
 * counting the same group from two different sources is how a marshal and a
 * desk attendant end up arguing about who is missing — so there is one read,
 * one cache, and one answer.
 *
 * Null when the roster could not be read at all; the caller shows no count.
 */
export async function sessionCheckinCounts(
  sessionId: string,
  nowMs: number,
): Promise<Counts | null> {
  const roster = await sessionRoster(sessionId, nowMs);
  return roster ? countCheckedIn(roster) : null;
}

/* ── what the wait-time metrics need, captured at the send ──────────────── */

/**
 * WHEN A CALLED HEAT WAS CALLED — the anchor every wait time is measured from.
 *
 * It lives in the same races-current record the boards read, and it is
 * EPHEMERAL: Pandora drops its own entry ~20 minutes after the call and this
 * Redis copy ages out behind it. That is fine for a board (nothing is "currently
 * checking in" an hour later) and useless for a metric, so the send stamps it
 * into the briefing log while it still exists.
 *
 * MATCHED ON SESSION ID, never taken on trust. By the time a group is sent, the
 * track's record can already have rolled to the NEXT heat — stamping that call
 * time would silently measure the wrong group and make every average that
 * consumes it wrong in the same direction.
 */
export async function calledAtMsFor(track: TrackKey, sessionId: string): Promise<number | null> {
  if (!sessionId) return null;
  try {
    const raw = await redis.get(`pandora:last-race:fasttrax:${track}`);
    if (!raw) return null;
    const rec = JSON.parse(raw) as CalledRaceRecord;
    if (String(rec.sessionId ?? "") !== sessionId) return null;
    const ms = rec.calledAt ? Date.parse(rec.calledAt) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** When a session's racers checked in, folded to the two ends that matter. */
export interface SessionCheckinTimes {
  /** The first racer through the desk — the start of "time in the check-in area". */
  firstMs: number | null;
  /** The last one, at the moment of the send. */
  lastMs: number | null;
  checkedIn: number;
  total: number;
}

/**
 * The roster's check-in stamps, folded.
 *
 * `Participant.checkedIn` IS A TIMESTAMP and — probed against live rosters
 * 2026-08-12 — a proper ISO-8601 UTC one ("2026-08-13T02:14:38.000Z"), so
 * `Date.parse` is safe here. It is NOT the venue wall-clock-with-no-zone format
 * the timing broadcast sends, which would need parseVenueLocalMs and would be
 * four hours out if fed to Date.parse.
 *
 * FIRST AND LAST COLLAPSE FOR A GROUP CHECK-IN. When staff check a party in as
 * one action, every racer gets the SAME stamp to the millisecond (observed live:
 * a 3-racer heat, three identical stamps). The spread is therefore a real signal
 * for individually-scanned heats and a legitimate zero for group ones — not a
 * bug, but a thing any reader of the average has to know.
 *
 * Aggregates only, never the people. This is the same posture that took the
 * roster back out of briefing_assignments (owner 2026-08-11): a count and two
 * timestamps answer the question, so nothing person-level is stored.
 */
export async function sessionCheckinTimes(sessionId: string): Promise<SessionCheckinTimes | null> {
  if (!sessionId) return null;
  const roster = (await liveRoster(sessionId)) ?? (await cachedRoster(sessionId));
  if (!roster) return null;

  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let checkedIn = 0;
  for (const row of roster) {
    if (!participantCheckedIn(row)) continue;
    checkedIn += 1;
    // `true` is a legal shape for the flag and carries no time — it counts
    // towards the tally and contributes nothing to the span.
    const ms = typeof row.checkedIn === "string" ? Date.parse(row.checkedIn) : NaN;
    if (!Number.isFinite(ms)) continue;
    if (firstMs === null || ms < firstMs) firstMs = ms;
    if (lastMs === null || ms > lastMs) lastMs = ms;
  }
  return { firstMs, lastMs, checkedIn, total: roster.length };
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
      // The send marker rides along, so a board can clear its own rail the
      // moment staff send the heat — the same one Redis key the track boards
      // clear on, read once here rather than by each screen.
      const [counts, briefed] = await Promise.all([
        sessionCheckinCounts(heat.sessionId, nowMs),
        sessionBriefed(heat.sessionId).catch(() => null),
      ]);
      if (!counts || counts.total === 0) return null;
      return {
        ...heat,
        checkedIn: counts.checkedIn,
        total: counts.total,
        briefed: briefed != null,
      };
    }),
  );
  return rows.filter((r): r is CheckinProgressSession => r !== null);
}
