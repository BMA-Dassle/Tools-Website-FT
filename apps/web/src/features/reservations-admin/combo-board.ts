/**
 * Pure logic for the VIP combo board: live step progress (and, as of the
 * board-extraction PR, combo grouping / schedule indexing / row merging).
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 *
 * Everything here takes `nowMs` as a parameter (ET wall-clock ms, see
 * format.ts etWallMs/nowEtWallMs) so countdown/retirement logic stays
 * deterministic and unit-testable.
 */
import { etWallMs } from "./format";
import type { ComboScheduleStep } from "./types";

/** Where a combo itinerary step sits relative to now. Status truth first
 *  (bowling legStatus: QAMF lane state — completed = lane closed, arrived =
 *  lane open even when the clock disagrees), then the booked start +
 *  expected duration. `overdue` = schedule-active but the party hasn't
 *  checked in, or lane still open past its scheduled end. */
export function stepProgress(
  step: ComboScheduleStep,
  nowMs: number,
): {
  state: "done" | "active" | "upcoming";
  minsLeft: number;
  minsUntil: number;
  overdue: boolean;
} | null {
  if (step.legStatus === "completed") {
    return { state: "done", minsLeft: 0, minsUntil: 0, overdue: false };
  }
  if (!step.iso) return null;
  const startMs = etWallMs(step.iso);
  if (Number.isNaN(startMs)) return null;
  const endMs = startMs + step.durationMin * 60_000;
  if (step.legStatus === "arrived") {
    // Lane is open RIGHT NOW — active regardless of the clock; past the
    // scheduled end it's running over, not done.
    return {
      state: "active",
      minsLeft: Math.max(0, (endMs - nowMs) / 60_000),
      minsUntil: 0,
      overdue: nowMs >= endMs,
    };
  }
  if (nowMs >= endMs) return { state: "done", minsLeft: 0, minsUntil: 0, overdue: false };
  if (nowMs >= startMs)
    return {
      state: "active",
      minsLeft: (endMs - nowMs) / 60_000,
      minsUntil: 0,
      // A bowling step carries legStatus; schedule-active without an open
      // lane means the party hasn't checked in to the lane yet.
      overdue: step.legStatus != null && step.legStatus !== "arrived",
    };
  return { state: "upcoming", minsLeft: 0, minsUntil: (startMs - nowMs) / 60_000, overdue: false };
}
