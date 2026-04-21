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
 *   Blue  every 15 min  →  threshold 16 min blocks only the adjacent
 *                          heat. E.g. pick 3:30 → blocks 3:15 + 3:45;
 *                          next pickable is 4:00 (+30 min away).
 *   Mega  every 24 min  →  threshold 25 min. Mega Tuesdays run a
 *                          single long configuration; cadence is
 *                          roughly double that of Red/Blue.
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
  blue: 16,
  mega: 25,
};

/** Fallback for unknown track names — matches the old Red/Blue rule. */
const FALLBACK_SAME_TRACK_MIN = 20;

/** Cross-track buffer — finish heat, walk across, check in. */
export const CROSS_TRACK_MIN_GAP_MIN = 30;

/**
 * True if a candidate heat conflicts with a picked heat for the same
 * racer. Tracks are compared case-insensitively.
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

  const p = (pickedTrack ?? "").toLowerCase();
  const c = (candTrack ?? "").toLowerCase();
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
