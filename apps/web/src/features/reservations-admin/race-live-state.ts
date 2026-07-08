/**
 * Live race-session truth for the VIP combo board.
 *
 * Pandora's sessions list (GET /v2/bmi/sessions/{locationID}) stamps
 * `actualStart` / `actualEnd` on every session (added 2026-07-08 at our
 * request — explicit null until they happen, never omitted). That gives race
 * steps the same kind of truth signal bowling gets from QAMF lane state:
 * a heat is Done when it actually ran, not when the clock says it should
 * have. Deliberately timestamps, not a vendor state enum — enums drift
 * (the vt3 `status` lesson, lib/video-match.ts).
 *
 * Fallback + sanity layer: heats run in strict order per track, so the
 * last-called race persisted by the races-current proxy
 * (`pandora:last-race:fasttrax:{track}` Redis keys, warmed every minute by
 * checkin-alerts) is a watermark — anything the watermark has passed ran.
 * This also guards the observed data quirk where a session's `actualEnd`
 * never gets stamped (live 2026-07-08: Blue heat 35 sat "open" while heats
 * 36-40 finished after it).
 *
 * Pure derivation only — fetching lives in the admin reservations route.
 */
import { etWallMs } from "./format";

/** Where a race heat sits in the track's real lifecycle. */
export type RaceLiveState = "finished" | "on_track" | "called" | "not_called";

/** One session from Pandora's sessions list. `scheduledStart` is zoned UTC
 *  (unlike our liveHeats' naive ET) — compare via etWallMs, never string. */
export interface TrackSession {
  sessionId: string;
  scheduledStart: string;
  heatNumber: number;
  /** Stamped when the timing system actually starts/ends the session.
   *  Explicit null until then. Older cached proxy payloads may lack the
   *  fields entirely — treat absent as null. */
  actualStart?: string | null;
  actualEnd?: string | null;
}

/** Last-called race on a track — the persisted races/current entry
 *  (see app/api/pandora/races-current/route.ts saveRace). */
export interface TrackWatermark {
  /** Number per races/current, string per sessions list — compare as strings. */
  sessionId: number | string;
  heatNumber: number;
  calledAt: string;
}

export type TrackKey = "blue" | "red" | "mega";

/** Track from a BMI line name ("Starter Race Blue") or a stored heat track
 *  ("Blue Track"). Null when the name carries no track — skip enrichment. */
export function trackKeyFromName(name: string | null | undefined): TrackKey | null {
  const m = (name ?? "").match(/\b(red|blue|mega)\b/i);
  return m ? (m[1].toLowerCase() as TrackKey) : null;
}

/** Pandora auto-expires races/current entries ~20 min after the call, so a
 *  watermark older than that no longer means "being called right now". */
const CALLED_WINDOW_MS = 20 * 60_000;

/**
 * Resolve one heat's live state against its track's session list.
 *
 * Matching is track (caller pre-filters) + start minute: the bill's live heat
 * start and the session's scheduledStart are the same schedule-grid block, so
 * they agree to the minute once both are in the ET-wall frame.
 *
 * `nowMs` is real epoch ms (server clock) — used only for the called window;
 * all schedule comparison happens in the ET-wall frame via etWallMs.
 */
export function resolveRaceLiveState(args: {
  /** Naive ET wall-clock ISO — the liveHeats / heatId shape. */
  heatStartIso: string;
  /** Sessions for this heat's track, today. */
  sessions: TrackSession[];
  watermark?: TrackWatermark | null;
  nowMs: number;
}): { sessionId: string; heatNumber: number; raceState: RaceLiveState } | null {
  const { heatStartIso, sessions, watermark, nowMs } = args;
  const heatMinute = minuteOf(etWallMs(heatStartIso));
  if (heatMinute == null) return null;
  const target = sessions.find((s) => minuteOf(etWallMs(s.scheduledStart)) === heatMinute);
  if (!target) return null;

  // Finished: its own actualEnd, OR a later heat on the track has started
  // (actualEnd can fail to stamp — the orphan-session quirk), OR the called
  // watermark has moved past it (covers stale cached sessions missing the
  // actual* fields entirely).
  const laterHeatRan = sessions.some((s) => s.heatNumber > target.heatNumber && s.actualStart);
  const watermarkPast = watermark != null && watermark.heatNumber > target.heatNumber;
  const state: RaceLiveState =
    target.actualEnd || laterHeatRan || watermarkPast
      ? "finished"
      : target.actualStart
        ? "on_track"
        : isCalledNow(target, watermark, nowMs)
          ? "called"
          : "not_called";
  return { sessionId: target.sessionId, heatNumber: target.heatNumber, raceState: state };
}

/** This session is the track's current call (racers checking in at the grid). */
function isCalledNow(
  target: TrackSession,
  watermark: TrackWatermark | null | undefined,
  nowMs: number,
): boolean {
  if (!watermark || String(watermark.sessionId) !== target.sessionId) return false;
  const calledMs = Date.parse(watermark.calledAt);
  return Number.isFinite(calledMs) && nowMs - calledMs < CALLED_WINDOW_MS;
}

/** ET-wall ms → whole minutes (null on unparseable input). */
function minuteOf(ms: number): number | null {
  return Number.isNaN(ms) ? null : Math.round(ms / 60_000);
}
