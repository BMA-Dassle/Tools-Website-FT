/**
 * SHOULD THIS ROOM'S GROUP BE MOVED TO HOLDING BY ITSELF? PURE — no I/O, no clock.
 *
 * WHY THIS EXISTS (owner 2026-08-14): "the goal would be to auto move the session
 * to holding if the room empties… they're not near a computer." The press already
 * exists and works; the problem is that the person who knows the group has left is
 * standing in the pit area, not at the desk. On 2026-08-13 the button was pressed
 * 7 times across ~60 briefings, and when it WAS pressed it landed a median 24
 * seconds BEFORE the film's arithmetic end — someone at the board anticipating.
 * So this is not automating a slow press. It is covering the ~88% where no press
 * happens at all and the room's occupancy is only ever closed by the next group
 * replacing it.
 *
 * ─── NOT THE TIMER THAT WAS DELIBERATELY REMOVED ─────────────────────────
 *
 * The helmet phase used to expire after 30 seconds and drop the room to idle,
 * and the owner had that taken out the same week (see phase.ts): "don't auto
 * complete that section… there shouldn't be any auto moving to holding". That
 * rule stands and this does not touch it. `briefingTimelineAt` still parks on
 * `helmet` forever, the desk keeps its Send-to-holding control, and the room is
 * still occupied as far as the board is concerned.
 *
 * What changed is the EVIDENCE. A timer declares a room free because 30 seconds
 * passed, which is a guess that was wrong often enough to strand groups in a room
 * the board had already given away. This closes a room only when the venue's own
 * NVR reports that nothing has moved in it — an observation, not a schedule. If
 * the cameras cannot answer, nothing happens and staff press the button exactly
 * as they do today.
 *
 * ─── WHY THE ELIGIBILITY GATE IS THE FILM, NOT THE SEND ──────────────────
 *
 * Groups sit still to watch a safety film, and a still room reads as a quiet one.
 * So nothing here is allowed to fire until the film AND the helmet board are
 * done. After that point anyone still in the room is at the helmet racks getting
 * kitted, which is the noisiest thing they do all visit — a quiet room after the
 * film is an empty room. Verified against a full night of archive footage: fire
 * delay scales cleanly with roster size (1-2 racers a median +0:30, 10+ a median
 * +2:04), which is gear-up time and precisely what a clock cannot model.
 */
import { briefingTimelineAt } from "./phase";
import { HELMET_PHASE_MS, type BriefingRoomState } from "./types";

/** What the NVR said about the room. Mirrors nx/motion.server.ts's answer so
 *  this module stays free of any import that touches the network. */
export type RoomMotion = "quiet" | "motion" | "unknown";

/**
 * How long the room must have been still.
 *
 * 30s, from the backtest: it fires on 62 of 75 real occupancies against 56 at
 * 45s and 45 at 90s, and the extra firings are almost entirely 1-2 person groups
 * who genuinely leave before the film's arithmetic end. Every 30s firing checked
 * against the archive showed an empty room. Tighter than this is not worth
 * chasing — the sweep only runs once a minute, so sub-minute precision is
 * theoretical.
 */
export const QUIET_WINDOW_MS = 30_000;

/**
 * Past this long after the film ended, stop trying.
 *
 * A room still occupied an hour later is not a group who quietly left; it is a
 * send nobody ever closed, or a state that outlived its night. Those are for the
 * Redis TTL and for staff, not for a sweep that would eventually fire on a room
 * whose group went home. Comfortably longer than the worst real gap observed
 * (+8:09) and shorter than the room-abandoned backstop in phase.ts.
 */
export const MAX_ELIGIBLE_AGE_MS = 45 * 60_000;

export interface AutoHoldingInput {
  nowMs: number;
  /** The room's Redis display state. Null when the room is idle. */
  state: BriefingRoomState | null;
  /** What the NVR reported for QUIET_WINDOW_MS ending at `nowMs`. */
  motion: RoomMotion;
  /**
   * Who the track's pit lane currently has in its HOLDING slot, if anyone.
   *
   * THE DANGEROUS CASE. `sendToHolding` does not merely label a room: a new hold
   * DISPLACES the previous holding group straight into `racing`. Being wrong
   * there does not cost a stale box, it tells the pit board a group is on track
   * who is still sitting in the seats. A human pressing the button can see the
   * lane; this cannot, so when the slot is already taken by somebody else it
   * declines and leaves the decision to a person.
   */
  holdingSessionId: string | null;
  /** The staff-facing kill switch on the check-in board. */
  enabled: boolean;
}

export type AutoHoldingVerdict =
  | { move: false; why: string }
  | { move: true; sessionId: string; heatNumber: number | null; raceType: string | null };

/**
 * Decide, from facts only. Every refusal carries a `why` because this runs
 * unattended once a minute: a sweep that silently does nothing is impossible to
 * tell apart from a sweep that is broken, and the cron response is the only place
 * anyone will ever look.
 */
export function autoHoldingDecision(input: AutoHoldingInput): AutoHoldingVerdict {
  const { nowMs, state, motion, holdingSessionId, enabled } = input;

  if (!enabled) return { move: false, why: "switched off" };
  if (!state) return { move: false, why: "room idle" };
  if (!state.sessionId) return { move: false, why: "no session in the room" };

  // `assigned` is a group still walking over — the film has not even started.
  if (state.kind !== "timeline") return { move: false, why: "film not started" };

  const timeline = briefingTimelineAt(state, nowMs);
  if (timeline.phase !== "helmet")
    return { move: false, why: `film still running (${timeline.phase})` };

  // The helmet board is up. Give it its full run before believing a quiet room:
  // the group is choosing sizes, and the last thing they do is walk out.
  const sinceStart = nowMs - state.triggeredAtMs;
  const eligibleAt = timeline.videoMs + HELMET_PHASE_MS;
  if (sinceStart < eligibleAt) {
    return {
      move: false,
      why: `helmet board still up (${Math.round((eligibleAt - sinceStart) / 1000)}s)`,
    };
  }
  if (sinceStart > eligibleAt + MAX_ELIGIBLE_AGE_MS) {
    return { move: false, why: "too long after the film — leave it to staff" };
  }

  // `unknown` is NOT quiet. See nx/motion.server.ts: an unreadable relay answer
  // parsed as "no periods" would empty every room on the same tick.
  if (motion !== "quiet") {
    return { move: false, why: motion === "motion" ? "room still busy" : "no camera answer" };
  }

  if (holdingSessionId && holdingSessionId !== state.sessionId) {
    return { move: false, why: `holding already has session ${holdingSessionId}` };
  }

  return {
    move: true,
    sessionId: state.sessionId,
    heatNumber: state.heatNumber,
    raceType: state.raceType,
  };
}
