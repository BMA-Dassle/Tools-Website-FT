/**
 * Heat-conflict rules for one racer's bookings.
 *
 * Same track (Red ↔ Red, Blue ↔ Blue): block exactly the immediately-
 * adjacent heat on each side. We do this with a per-track time
 * threshold because each track runs on a different cadence:
 *
 *   Red   every 12 min  →  threshold 13 min blocks only the adjacent
 *                          heat. E.g. pick 3:24 → blocks 3:12 + 3:36;
 *                          next pickable is 3:48 (+24 min away).
 *   Blue  every 12 min  →  threshold 13 min, same as Red. (Blue ran a
 *                          15-min cadence / 16-min threshold until
 *                          2026-07-02; owner: 12 min from now on.)
 *   Mega  every 12 min  →  same cadence as Red (threshold 13 min). On
 *                          Mega Tuesdays both tracks combine into a
 *                          single long configuration but the heat
 *                          clock still ticks every 12 min.
 *
 * Using an adjacent-only rule (instead of a wall-clock gap) means the
 * blocking scales naturally with whatever cadence BMI is running
 * without us having to keep a config in lockstep with the track clock.
 *
 * Cross-track (Red ↔ Blue): 30 min buffer to let the racer finish the
 * heat, walk between the two tracks, and check in on the other side.
 * The number is independent of cadence because the bottleneck is the
 * physical walk, not the schedule.
 */

/** Per-track adjacent-heat threshold, in minutes. */
export const TRACK_ADJACENT_GAP_MIN: Record<string, number> = {
  red: 13,
  blue: 13, // 12-min cadence since 2026-07-02 (was 15-min / 16)
  mega: 13, // Mega runs the same 12-min cadence as Red
};

/** Fallback for unknown track names — matches the old Red/Blue rule. */
const FALLBACK_SAME_TRACK_MIN = 20;

/** Cross-track buffer — finish heat, walk across, check in. */
export const CROSS_TRACK_MIN_GAP_MIN = 30;

/**
 * Canonical track identity for comparison. Different rails label the SAME
 * physical track differently: the picker stores "Red"/"Blue"/"Mega" while
 * BMI-derived rows carry the dayplanner resource name "Red Track"/
 * "Blue Track"/"Mega Track". An exact string compare read those as
 * DIFFERENT tracks and applied the 30-min cross-track walk buffer —
 * wrongly blocking the every-other-heat (24-min) same-track pattern the
 * rules exist to allow (kiosk live find 2026-07-19). Lowercases and strips
 * a trailing "track" word so both formats compare equal; empty/unknown
 * stays "" (still treated as cross-track — unchanged).
 * Kept in lockstep with v2 `src/features/booking/service/conflict.ts`.
 */
function normalizeTrack(track: string | null | undefined): string {
  return (track ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]*track$/, "");
}

/**
 * True if a candidate heat conflicts with a picked heat for the same
 * racer. Tracks are compared case-insensitively with a trailing "Track"
 * word stripped ("Red Track" ≡ "Red" — see normalizeTrack).
 *
 * @param pickedStart  epoch ms or Date of the already-picked heat
 * @param pickedTrack  "Red" | "Blue" | "Mega" | null
 * @param candStart    epoch ms or Date of the candidate heat
 * @param candTrack    track of the candidate heat
 */
export function heatsConflict(
  pickedStart: number | Date,
  pickedTrack: string | null | undefined,
  candStart: number | Date,
  candTrack: string | null | undefined,
): boolean {
  const pickedMs = pickedStart instanceof Date ? pickedStart.getTime() : pickedStart;
  const candMs = candStart instanceof Date ? candStart.getTime() : candStart;
  const diffMin = Math.abs(candMs - pickedMs) / 60_000;

  const p = normalizeTrack(pickedTrack);
  const c = normalizeTrack(candTrack);
  const sameTrack = p !== "" && p === c;

  if (sameTrack) {
    const gap = TRACK_ADJACENT_GAP_MIN[p] ?? FALLBACK_SAME_TRACK_MIN;
    return diffMin < gap;
  }
  return diffMin < CROSS_TRACK_MIN_GAP_MIN;
}

/** Short human-readable explainer for a conflict's source, for tooltips. */
export const HEAT_CONFLICT_TOOLTIP =
  "Pick a different heat — this one's too close. Same-track heats need to skip at least one slot between them, and jumping between tracks needs 30 minutes to walk across and check in.";

/**
 * Package heat-gap rule: candidate must start at least `minutes` after
 * a previously-picked component finished. Used by the Ultimate
 * Qualifier package to enforce "Intermediate must start ≥ 60 min
 * after Starter ends" (qualifying race + buffer for video review +
 * appetizer at Nemo's).
 *
 * @param prevStop  ISO string or epoch ms of the previous heat's STOP time
 * @param candStart ISO string or epoch ms of the candidate heat's START
 * @param minutes   minimum gap in minutes
 * @returns true when the candidate violates the gap (i.e. is too soon)
 */
export function violatesMinGapAfter(
  prevStop: string | number | Date,
  candStart: string | number | Date,
  minutes: number,
): boolean {
  const prevMs =
    typeof prevStop === "string"
      ? Date.parse(prevStop)
      : prevStop instanceof Date
        ? prevStop.getTime()
        : prevStop;
  const candMs =
    typeof candStart === "string"
      ? Date.parse(candStart)
      : candStart instanceof Date
        ? candStart.getTime()
        : candStart;
  if (!Number.isFinite(prevMs) || !Number.isFinite(candMs)) return false;
  return candMs < prevMs + minutes * 60_000;
}

/**
 * Effective package gap for ONE candidate heat: `sameTrackMinutes` when the
 * candidate runs on the SAME track as the referenced pick, otherwise the
 * base `minutes`. Tracks are compared with the same normalizer
 * `heatsConflict` uses ("Blue Track" ≡ "Blue"); an empty/unknown track on
 * either side counts as a track CHANGE and keeps the stricter number.
 *
 * Owner rule 2026-08-04: the Ultimate Qualifier's 60-min Starter→
 * Intermediate buffer covers qualifying, the POV review, the appetizer AND
 * the walk to the other track. Staying on one track drops the walk, so
 * same-track pairs only need 30. Rules without `sameTrackMinutes` stay
 * track-agnostic.
 * Kept in lockstep with v2 `src/features/booking/service/conflict.ts`.
 */
export function packageGapMinutesFor(
  rule: { minutes: number; sameTrackMinutes?: number },
  refTrack: string | null | undefined,
  candidateTrack: string | null | undefined,
): number {
  if (rule.sameTrackMinutes === undefined) return rule.minutes;
  const a = normalizeTrack(refTrack);
  const b = normalizeTrack(candidateTrack);
  return a !== "" && a === b ? rule.sameTrackMinutes : rule.minutes;
}

/** Short tooltip explainer for the package gap rule. The component
 *  fills in the actual minutes / qualifier label at render time. */
export function packageGapTooltip(minutes: number, refLabel: string): string {
  return `Available ${minutes} min after your ${refLabel} ends — gives you time to qualify, review your POV video, and grab your appetizer.`;
}
