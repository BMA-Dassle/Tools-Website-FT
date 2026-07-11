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
 * The last-called race persisted by the races-current proxy
 * (`pandora:last-race:fasttrax:{track}` Redis keys, warmed every minute by
 * checkin-alerts) powers ONLY the "called" state. It is a check-in call,
 * not a track log: staff call racers to the grid 1-2 heats AHEAD of what's
 * actually running (live 2026-07-10: heat 47 called at 8:07 PM while heat
 * 45 was still on track and 46 hadn't run), so "the watermark passed this
 * heat" must never imply the heat ran. The orphan-session quirk — a
 * session's `actualEnd` never gets stamped (live 2026-07-08: Blue heat 35
 * sat "open" while heats 36-40 finished after it) — is guarded by a later
 * heat's actualStart instead.
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
  // (actualEnd can fail to stamp — the orphan-session quirk). The called
  // watermark deliberately does NOT finish a heat: the grid call runs 1-2
  // heats ahead of the track, so at 8:07 PM on 2026-07-10 the watermark
  // (heat 47) had "passed" heat 46 while 45 was still racing — the board
  // marked two 8:00 PM combos Done for a heat that hadn't run, and the
  // settle gate would have charged them just as early.
  const laterHeatRan = sessions.some((s) => s.heatNumber > target.heatNumber && s.actualStart);
  const state: RaceLiveState =
    target.actualEnd || laterHeatRan
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

// ── Settle gate (race-dayof-pay fallback) ────────────────────────────────────

/** One booked heat as stored in booking_metadata.heats: `heatId` is the naive
 *  ET block-start, `track` the booking-time track ("Blue Track"). */
export interface SettleHeat {
  startIso: string;
  track?: string | null;
}

/** Whether a heat may settle by clock alone. Owner decisions 2026-07-08:
 *  unresolvable heats wait 45 min past scheduled start (Pandora gets a
 *  chance, money never sticks); a resolved-but-never-finished session is
 *  force-done at +6h (mirrors the board's hard cap). */
const SETTLE_GRACE_MS = 45 * 60_000;
const SETTLE_HARD_CAP_MS = 6 * 60 * 60_000;

/**
 * Should race-dayof-pay's no-check-in fallback settle this bill?
 *
 * Eligible only when EVERY booked heat is delivered: its session actually
 * finished (truth), or — when Pandora can't resolve it (stale metadata after
 * an office reschedule, outage, missing track) — 45 min past its scheduled
 * start. A heat that RESOLVES but hasn't finished waits, even past +45
 * (truth beats the safety net), up to the +6h hard cap. Heats dated before
 * today (ET) settle by clock immediately — Pandora is same-day only and
 * those already ran.
 *
 * `nowMs` is real epoch ms; heat epochs use the same month-approx ET offset
 * as race-dayof-pay's bmiStartEpoch, so the two clocks agree.
 */
export function raceSettleGate(args: {
  heats: SettleHeat[];
  sessionsByTrack: Partial<Record<TrackKey, TrackSession[]>>;
  watermarks: Partial<Record<TrackKey, TrackWatermark>>;
  nowMs: number;
  /** Today's ET date, "YYYY-MM-DD" (heat dates are naive ET so this is a
   *  plain string compare). */
  todayEtYmd: string;
}): { eligible: boolean; reason: string } {
  const { heats, sessionsByTrack, watermarks, nowMs, todayEtYmd } = args;
  if (heats.length === 0) return { eligible: false, reason: "no heats recorded" };

  const doneVia: string[] = [];
  for (const heat of heats) {
    const hhmm = heat.startIso.slice(11, 16);
    if (heat.startIso.slice(0, 10) < todayEtYmd) {
      doneVia.push("clock-past-date");
      continue;
    }
    const startMs = etNaiveEpochMs(heat.startIso);
    const pastGrace = Number.isFinite(startMs) && nowMs > startMs + SETTLE_GRACE_MS;
    const pastHardCap = Number.isFinite(startMs) && nowMs > startMs + SETTLE_HARD_CAP_MS;
    const track = trackKeyFromName(heat.track);
    const sessions = track ? sessionsByTrack[track] : undefined;
    const live =
      track && sessions
        ? resolveRaceLiveState({
            heatStartIso: heat.startIso,
            sessions,
            watermark: watermarks[track],
            nowMs,
          })
        : null;
    if (live) {
      if (live.raceState === "finished") {
        doneVia.push("finished");
        continue;
      }
      if (pastHardCap) {
        doneVia.push("clock-hardcap");
        continue;
      }
      return { eligible: false, reason: `waiting: ${hhmm} heat ${live.raceState}` };
    }
    // Unresolvable — clock safety net.
    if (pastGrace) {
      doneVia.push("clock-45m");
      continue;
    }
    return { eligible: false, reason: `waiting: ${hhmm} heat unresolved (45m grace)` };
  }

  const reason = doneVia.every((v) => v === "finished")
    ? "race-finished"
    : doneVia.includes("clock-hardcap")
      ? "clock-hardcap"
      : doneVia.includes("clock-45m")
        ? "clock-45m"
        : "clock-past-date";
  return { eligible: true, reason };
}

/** Naive ET ISO → real epoch ms, using the same month-approx DST offset as
 *  race-dayof-pay's bmiStartEpoch (deliberate parity — the gate and the cron
 *  must agree on when "start + grace" falls). */
function etNaiveEpochMs(iso: string): number {
  const month = Number(iso.slice(5, 7));
  const offset = month >= 3 && month <= 11 ? "-04:00" : "-05:00"; // EDT vs EST (approx)
  return Date.parse(iso.replace(/Z$/, "") + offset);
}
