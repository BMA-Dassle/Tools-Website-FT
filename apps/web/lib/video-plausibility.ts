/**
 * Footage-window plausibility — the third leg of the video-match
 * contract (2026-08-10 hardening, from the 8/9 W57384 VIP incident).
 *
 * A camera scan says "camera 24 belongs to racer R for heat H". A video
 * from camera 24 says nothing about WHICH heat it recorded — VT3's
 * `created_at` is dock/ingest time, not capture time, and no
 * recording-start field exists. When a camera misses a capture (dead
 * battery, skipped heat — 9 of 14 did on 8/9), the earliest-unfilled
 * walk pairs the camera's NEXT video with the stale unfilled scan and
 * texts a stranger's race to the racer. 95 wrong-footage matches went
 * out on 8/9 alone, 87 of them SMS-delivered.
 *
 * This module answers, per candidate assignment: could this footage
 * belong to that assignment's heat?
 *
 *   footage window = [created_at − duration, created_at]
 *
 * `created_at − duration` is the LATEST POSSIBLE capture start
 * (recording ends before docking), so a camera docked hours late can
 * only push its own video OUT of the window — i.e. toward a held
 * review, never toward a misdelivery. Failing in that direction is
 * deliberate.
 *
 * Verdict rule — midpoint-or-containment, NOT bare overlap: the
 * footage MIDPOINT must fall inside the padded heat window, OR the
 * footage must fully CONTAIN the padded window (a camera left
 * recording across several heats still holds the racer's race). Bare
 * any-overlap is disqualified by data: on 8/9, 12 wrong deliveries
 * (including all 8 red-h16 videos mis-sent to the h17 party) clipped
 * the padded window's edge by seconds and would have passed it.
 *
 * Heat-window ladder (first applicable rung wins):
 *   1. "actuals"     — Pandora actualStart+actualEnd known:
 *                      [aStart − PRE, aEnd + POST]
 *   2. "start-only"  — actualStart known, actualEnd never stamped
 *                      (known Pandora gap): [aStart − PRE,
 *                      aStart + MAX_HEAT + POST]
 *   3. "scan-anchor" — no actuals (cold cache / heat not started per
 *                      Pandora): anchor on the assignment's own scan
 *                      time, [assignedAt − PRE, assignedAt + MAX_HEAT
 *                      + POST]. NEVER naked scheduledStart — on
 *                      late-running nights it lies by 10–40 min (the
 *                      exact door the 8/9 red-h16 mis-scan walked
 *                      through).
 *
 * Pure module — no Redis, no fetch. Callers resolve the session's
 * actual window (lib/session-actuals.ts) and pass it in; the replay
 * harness feeds historical windows directly.
 *
 * Kill switch: VIDEO_MATCH_PLAUSIBLE=false restores pre-gate matching
 * exactly (house rule: flags are kill switches, default ON).
 */

/** Estimated capture span derived from a VT3 video record. */
export interface CaptureWindow {
  /** Latest-possible capture start: created_at − duration. */
  startMs: number;
  /** Dock/ingest time (VT3 created_at). */
  endMs: number;
}

/** What we know about when the candidate's heat actually ran. */
export interface HeatActuals {
  /** Pandora actualStart, epoch ms. */
  aStartMs?: number;
  /** Pandora actualEnd, epoch ms. Occasionally never stamps. */
  aEndMs?: number;
}

export type PlausibilityVerdict = "plausible" | "implausible" | "unknown";

/** Which ladder rung produced the window (for the decision log). */
export type PlausibilityLadder = "actuals" | "start-only" | "scan-anchor" | "no-duration";

export interface PlausibilityResult {
  verdict: PlausibilityVerdict;
  ladder: PlausibilityLadder;
  /** The padded heat window the footage was judged against. Absent
   *  for "unknown" (no capture window to judge). */
  windowStartMs?: number;
  windowEndMs?: number;
}

export function plausibilityEnabled(): boolean {
  return process.env.VIDEO_MATCH_PLAUSIBLE !== "false";
}

function envSeconds(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Staging slack — cameras start recording at the grid scan, a few
 *  minutes before actualStart. Calibrated on the 8/9 corpus. */
export function plausiblePreSlackS(): number {
  return envSeconds("VIDEO_PLAUSIBLE_PRE_S", 270);
}

/** Pit-return slack — recording runs past actualEnd until the kart
 *  is back and the camera stops. */
export function plausiblePostSlackS(): number {
  return envSeconds("VIDEO_PLAUSIBLE_POST_S", 210);
}

/** Ceiling for one heat's staging+race+return when actualEnd (or all
 *  actuals) are missing. 12-min cadence, 8–18 min observed heats. */
export function plausibleMaxHeatS(): number {
  return envSeconds("VIDEO_PLAUSIBLE_MAX_HEAT_S", 1500);
}

/**
 * Footage window from a VT3 record. Null when duration or created_at
 * is missing/invalid — verdict becomes "unknown" and matching behaves
 * exactly as before the gate.
 */
export function estimateCaptureWindow(
  createdAt: string | undefined | null,
  durationS: number | undefined | null,
): CaptureWindow | null {
  if (!createdAt || typeof durationS !== "number" || !Number.isFinite(durationS) || durationS <= 0)
    return null;
  const endMs = new Date(createdAt).getTime();
  if (!Number.isFinite(endMs)) return null;
  return { startMs: endMs - durationS * 1000, endMs };
}

/**
 * Judge one candidate assignment against a footage window.
 *
 * `assignedAtMs` — the candidate scan's own timestamp (always present
 * on assignments); the rung-3 anchor.
 */
export function plausibilityVerdict(
  capture: CaptureWindow | null,
  actuals: HeatActuals | null | undefined,
  assignedAtMs: number,
): PlausibilityResult {
  if (!capture) return { verdict: "unknown", ladder: "no-duration" };

  const preMs = plausiblePreSlackS() * 1000;
  const postMs = plausiblePostSlackS() * 1000;
  const maxHeatMs = plausibleMaxHeatS() * 1000;

  let ladder: PlausibilityLadder;
  let windowStartMs: number;
  let windowEndMs: number;
  const aStart = actuals?.aStartMs;
  const aEnd = actuals?.aEndMs;
  if (typeof aStart === "number" && typeof aEnd === "number") {
    ladder = "actuals";
    windowStartMs = aStart - preMs;
    windowEndMs = aEnd + postMs;
  } else if (typeof aStart === "number") {
    ladder = "start-only";
    windowStartMs = aStart - preMs;
    windowEndMs = aStart + maxHeatMs + postMs;
  } else {
    ladder = "scan-anchor";
    windowStartMs = assignedAtMs - preMs;
    windowEndMs = assignedAtMs + maxHeatMs + postMs;
  }
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    // Garbage anchor (unparseable assignedAt) — refuse to guess.
    return { verdict: "unknown", ladder };
  }

  const midMs = (capture.startMs + capture.endMs) / 2;
  const midpointInside = midMs >= windowStartMs && midMs <= windowEndMs;
  const containsWindow = capture.startMs <= windowStartMs && capture.endMs >= windowEndMs;
  return {
    verdict: midpointInside || containsWindow ? "plausible" : "implausible",
    ladder,
    windowStartMs,
    windowEndMs,
  };
}
