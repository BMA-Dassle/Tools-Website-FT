import "server-only";

/**
 * THE NEXT SESSION THAT NEEDS CALLING, per track — assembled from three reads
 * that are all already warm, and folded by the pure `session-call.ts`.
 *
 * ── WHERE EACH FACT COMES FROM ──────────────────────────────────────────────
 *
 * THE GRID (every slot, including the empty ones the wall gate needs) comes from
 * `fetchTrackSessions`, which reads the Redis copy the pre-race-tickets cron
 * writes every 2 minutes and shares one live Pandora read per track per 15s
 * among default callers. Nothing new is polled for this feature.
 *
 * WHO IS BOOKED comes from the participants cache the same cron warms
 * (`pandora:participants:{location}:{sessionId}:R1`), read with one MGET. A
 * missing key means WE DO NOT KNOW, which the fold treats very differently from
 * zero — an unknown count never raises a warning and never lets the wall speak.
 *
 * ⚠️ THAT PAYLOAD IS FULL PII (names, emails, phones — see the gating note in
 * app/api/pandora/session-participants/route.ts). Only its LENGTH ever leaves
 * this function. Nothing downstream receives a participant.
 *
 * WHETHER IT HAS BEEN CALLED comes from the races-current watermark
 * (`pandora:last-race:fasttrax:{track}`), the live called signal BMI drives. A
 * watermark beats a set of called ids here because it also covers the gap the
 * briefing log cannot: a heat is called ~7 minutes before it is sent to a room,
 * and the briefing row that carries `called_at` is only written on the send. Read
 * from a set of sent rows, a called-but-not-yet-sent heat would look uncalled and
 * the board would nag about a call staff had already made.
 *
 * Heat numbers are per-track and ascending within a track's day, so anything at
 * or below the watermark's heat has been called. The watermark is only trusted
 * when its own `calledAt` is recent — the key has no TTL, so yesterday's last
 * heat would otherwise silence the whole of tonight.
 *
 * NEVER THROWS. Every failure path yields "no answer for this track", which
 * renders as the board and the wall look today.
 */
import redis from "@/lib/redis";
import { businessDayYmdET, calendarYmdET } from "@/lib/race-business-day";
import {
  fetchTrackSessions,
  fetchTrackWatermarks,
} from "~/features/reservations-admin/race-live-state.server";
import type { TrackKey } from "~/features/reservations-admin/race-live-state";
import { CALL_ABANDON_MIN, nextCheckIn, type CallGridSlot, type NextCheckIn } from "./session-call";
import type { OnTimeSnapshot } from "./on-time";

const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const TRACKS: TrackKey[] = ["blue", "red", "mega"];

/**
 * How far ahead to look. Two heats past the one we expect to name is enough to
 * decide the gate, and keeps the MGET small on a Mega night when one grid covers
 * both rooms.
 */
const HORIZON_AHEAD_MIN = 90;

/** Hard cap per track, so a republished grid cannot turn this into a big MGET. */
const MAX_SLOTS_PER_TRACK = 12;

/**
 * A watermark older than this is yesterday's, and comparing tonight's heat
 * numbers against it would mark every session called.
 */
const WATERMARK_MAX_AGE_MS = 12 * 3600_000;

export type NextCheckInByTrack = Partial<Record<TrackKey, NextCheckIn>>;

/**
 * Redis fan-in, matching the posture `on-time.server.ts` uses. Every board on the
 * property polls track-status at 1-2s and the answer is the same for all of them,
 * so the reads above happen a few times a minute rather than per board per second.
 *
 * This is a SIBLING of the on-time cache rather than a field inside it: the two
 * are different facts, and folding this into `OnTimeSnapshot` would point
 * on-time.ts at session-call.ts while session-call.ts already depends on it for
 * CALL_LEAD_MIN.
 */
const CACHE_KEY = "session-call:next:v1";
const CACHE_TTL_SEC = 8;

/** Participant-cache key. MUST mirror the key the session-participants proxy
 *  writes (`R1` = excludeRemoved, which is what the crons warm). */
function participantsKey(sessionId: string): string {
  return `pandora:participants:${FASTTRAX_LOCATION_ID}:${sessionId}:R1`;
}

/** How many racers that cached payload holds, or null if we have no record. */
function countFrom(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

/**
 * One track's grid, as slots, with the called watermark applied.
 *
 * `actualStart` is a second, independent "it has been called" — a heat that has
 * already gone green plainly was — which covers a watermark that never landed.
 */
async function readTrackSlots(
  track: TrackKey,
  ymds: string[],
  nowMs: number,
  watermarkHeat: number | null,
  watermarkCalledAtMs: number | null,
): Promise<CallGridSlot[]> {
  const lists = await Promise.all(ymds.map((ymd) => fetchTrackSessions(track, ymd)));
  const bySession = new Map<
    string,
    { slotMs: number; heatNumber: number; actualStart: number | null }
  >();
  for (const list of lists) {
    for (const s of list ?? []) {
      const slotMs = Date.parse(s.scheduledStart);
      if (!Number.isFinite(slotMs)) continue;
      const actual = s.actualStart ? Date.parse(s.actualStart) : NaN;
      bySession.set(String(s.sessionId), {
        slotMs,
        heatNumber: s.heatNumber,
        actualStart: Number.isFinite(actual) ? actual : null,
      });
    }
  }

  const inHorizon = [...bySession.entries()]
    .filter(
      ([, v]) =>
        v.slotMs >= nowMs - CALL_ABANDON_MIN * 60_000 &&
        v.slotMs <= nowMs + HORIZON_AHEAD_MIN * 60_000,
    )
    .sort((a, b) => a[1].slotMs - b[1].slotMs)
    .slice(0, MAX_SLOTS_PER_TRACK);
  if (!inHorizon.length) return [];

  let counts: (string | null)[] = [];
  try {
    counts = await redis.mget(...inHorizon.map(([sid]) => participantsKey(sid)));
  } catch {
    // No counts ⇒ every slot reads as "unknown", which stays silent by design.
    counts = inHorizon.map(() => null);
  }

  return inHorizon.map(([sid, v], i) => {
    const calledByWatermark =
      watermarkHeat != null &&
      watermarkCalledAtMs != null &&
      nowMs - watermarkCalledAtMs <= WATERMARK_MAX_AGE_MS &&
      v.heatNumber <= watermarkHeat;
    return {
      sessionId: sid,
      heatNumber: v.heatNumber,
      slotMs: v.slotMs,
      booked: countFrom(counts[i] ?? null),
      calledAtMs: calledByWatermark ? watermarkCalledAtMs : v.actualStart,
    };
  });
}

/**
 * The next session needing a call on each track.
 *
 * `onTime` supplies each track's live flag offset, which is what makes the call
 * window slide as a night falls behind. A STALE FEED is treated as no offset at
 * all: `flagOffsetMin` survives on the payload after the feed dies, and using it
 * would anchor tonight's calls to whenever the pipe went quiet. No offset means
 * the pure fold falls back to the desk's flat rule.
 */
export async function readNextCheckIns(
  onTime: OnTimeSnapshot | null,
  nowMs: number = Date.now(),
): Promise<NextCheckInByTrack> {
  const out: NextCheckInByTrack = {};
  try {
    const ymds = [...new Set([calendarYmdET(), businessDayYmdET()])];
    const watermarks = await fetchTrackWatermarks();

    await Promise.all(
      TRACKS.map(async (track) => {
        const wm = watermarks[track];
        const wmCalledAt = wm?.calledAt ? Date.parse(wm.calledAt) : NaN;
        const slots = await readTrackSlots(
          track,
          ymds,
          nowMs,
          wm?.heatNumber ?? null,
          Number.isFinite(wmCalledAt) ? wmCalledAt : null,
        );
        if (!slots.length) return;

        const t = onTime?.tracks?.[track];
        const offsetMin = t && !t.feedStale ? t.flagOffsetMin : null;
        const next = nextCheckIn(slots, nowMs, offsetMin ?? null);
        if (next) out[track] = next;
      }),
    );
  } catch (err) {
    console.error("[session-call] next check-in read failed", err);
  }
  return out;
}

/**
 * The cached read every surface actually calls.
 *
 * A cache miss computes; a Redis failure computes. Like the on-time snapshot this
 * must never be the reason a board goes blank, so every failure path falls
 * through to the live read rather than throwing.
 *
 * The cached entry is stamped with the moment it was built and discarded once it
 * is older than its TTL, because a call window is a statement about NOW: serving
 * a minute-old "call due" after Redis has misbehaved would nag about a call that
 * has since been made.
 */
export async function getNextCheckIns(
  onTime: OnTimeSnapshot | null,
  nowMs: number = Date.now(),
): Promise<NextCheckInByTrack> {
  try {
    const raw = await redis.get(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as { atMs: number; tracks: NextCheckInByTrack };
      if (cached?.atMs != null && nowMs - cached.atMs <= CACHE_TTL_SEC * 1000) return cached.tracks;
    }
  } catch {
    /* fall through to a live read */
  }

  const tracks = await readNextCheckIns(onTime, nowMs);
  try {
    await redis.set(CACHE_KEY, JSON.stringify({ atMs: nowMs, tracks }), "EX", CACHE_TTL_SEC);
  } catch {
    /* best-effort */
  }
  return tracks;
}
