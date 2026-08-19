/**
 * WHERE A BOWLING RESERVATION IS IN THE LANE LIFECYCLE — the one rule, pure.
 *
 * Extracted from the check-in route so the front-desk wall's every-minute cron and the
 * guest's own check-in page cannot disagree about whether a lane is ready. That
 * disagreement is not hypothetical: the wall invites the guest, so if it said "ready"
 * where the route said `not_ready`, the guest walks to a kiosk and is refused — and the
 * board that sent them is the last thing they will trust afterwards. One function, both
 * callers, and a second copy is the thing this file exists to prevent.
 *
 * PURE: hand it what the two QAMF reads returned and it decides. No fetching, no clock
 * read — `nowMs` comes in — so the whole state machine is testable by passing objects.
 *
 * See docs/qamf-lane-lifecycle.md for the vendor state machine this reads.
 */
import type { BookedLane, Lane } from "@/lib/qamf-bowling";

export type LanePhase = "not_ready" | "ready" | "running" | "completed" | "cancelled";

/**
 * How close to the slot the self-service gate opens.
 *
 * THIRTY MINUTES, and it is load-bearing rather than a nice round number: outside it a
 * guest may not open a lane themselves at all, however idle the hardware looks, because
 * an idle lane an hour before a booking is somebody else's lane between games. Inside
 * it, a physically-closed assigned lane means "yours, waiting" (owner 2026-08-19
 * independently landed on the same 30 minutes for the wall).
 */
export const SELF_SERVICE_WINDOW_MINS = 30;

export interface LanePhaseInput {
  /** The reservation's booked lanes, from `getReservation().Lanes`. */
  lanes: BookedLane[];
  /**
   * The centre's PHYSICAL lanes, from `listLanes()`. Only consulted for the
   * self-service gate; pass an empty array to skip that half (the gate then cannot
   * open, which is the safe direction).
   */
  physicalLanes: Lane[];
  /** `getReservation().BookedAt` as ms, or 0 when unknown. */
  bookedAtMs: number;
  nowMs: number;
}

export interface LanePhaseResult {
  phase: LanePhase;
  /** Assigned lane numbers, ascending. Empty when none are assigned yet. */
  laneNumbers: number[];
  /** True only when a GUEST may open the lane themselves right now. */
  canSelfCheckIn: boolean;
  /** Why the self-service gate opened, for logs and for the admin board. */
  gate: "booked-lane-ready" | "physical-lanes-closed" | null;
}

/** "Lane 12" / "Lanes 12, 13" / "" — the one place this string is built. */
export function laneLabel(nums: number[]): string {
  if (nums.length === 0) return "";
  return nums.length === 1 ? `Lane ${nums[0]}` : `Lanes ${nums.join(", ")}`;
}

/**
 * Resolve the phase, and whether a guest may open the lane themselves.
 *
 * The order of the status tests is the state machine's own precedence and must not be
 * reordered: Completed beats Running beats Ready, because a reservation whose lanes have
 * finished is done even if another lane on it still reads Running.
 */
export function resolveLanePhase(input: LanePhaseInput): LanePhaseResult {
  const { lanes, physicalLanes, bookedAtMs, nowMs } = input;

  const laneNumbers = lanes
    .map((l) => l.LaneNumber)
    .filter((n): n is number => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);

  const statuses = lanes.map((l) => l.Status);

  if (statuses.some((s) => s === "Completed")) {
    return { phase: "completed", laneNumbers, canSelfCheckIn: false, gate: null };
  }
  if (statuses.some((s) => s === "Running")) {
    // Already bowling. Not "ready" — there is nothing left to open.
    return { phase: "running", laneNumbers, canSelfCheckIn: false, gate: null };
  }
  if (statuses.some((s) => s === "Ready")) {
    // Staff set the booked lane to Ready in Conqueror. The plainest case.
    return { phase: "ready", laneNumbers, canSelfCheckIn: true, gate: "booked-lane-ready" };
  }

  // THE SELF-SERVICE GATE. Lanes are assigned but nobody has marked them Ready, which is
  // the normal state at a busy desk. Inside the window, a guest may start an assigned
  // lane themselves IF every one of those lanes is physically Closed — hardware off and
  // nobody on it. Any lane reading Error or already Open means staff need to look at it,
  // so the gate stays shut rather than handing a guest a lane that is not theirs.
  if (laneNumbers.length > 0 && bookedAtMs > 0) {
    const minsUntilBooked = (bookedAtMs - nowMs) / 60_000;
    if (minsUntilBooked <= SELF_SERVICE_WINDOW_MINS) {
      // EVERY LANE ON THE RESERVATION IS CHECKED INDIVIDUALLY, and each must be present
      // and physically `Closed` — not `Open` (somebody else is on it, or it is mid-game),
      // not `Error` (staff need to look at it), not `None` (unconfigured), and not absent
      // from the response at all.
      //
      // Driven from the RESERVATION's lanes rather than from what the response happened to
      // contain, which is the whole point. Two earlier shapes of this check were wrong in
      // ways that both opened the gate on incomplete information:
      //
      //   · `assigned.every(Closed)` over a filtered list — a response missing lane 13
      //     silently passed, because every lane it FOUND was fine.
      //   · comparing counts — a duplicated lane 12 made the arithmetic agree while 13
      //     went unexamined.
      //
      // A lane we have not positively seen as Closed is a lane we cannot promise.
      const byNumber = new Map<number, Lane["Status"]>();
      for (const pl of physicalLanes) byNumber.set(pl.LaneNumber, pl.Status);
      const everyLaneFree = laneNumbers.every((n) => byNumber.get(n) === "Closed");
      if (everyLaneFree) {
        return {
          phase: "ready",
          laneNumbers,
          canSelfCheckIn: true,
          gate: "physical-lanes-closed",
        };
      }
    }
  }

  return { phase: "not_ready", laneNumbers, canSelfCheckIn: false, gate: null };
}
