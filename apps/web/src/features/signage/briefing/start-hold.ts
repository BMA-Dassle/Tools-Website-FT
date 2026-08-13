/**
 * THE PAUSE BETWEEN SEND AND START. PURE — a room state and a clock in, ms out.
 *
 * The two-phase send exists because the group has to WALK there: Send holds a
 * "take a seat" board, Start rolls the film once they are sitting in front of it.
 * On the floor that gap collapsed — staff press Send and Start back-to-back at the
 * desk (owner 2026-08-12: "they are hitting send to room then hit start video
 * right after each other"), so the safety briefing opens to an empty room while
 * the group is still being pulled from check-in. A briefing nobody is in the room
 * for is the exact failure this whole feature was built to prevent.
 *
 * So Start is held for ten seconds after a send, and the BUTTON COUNTS THE HOLD
 * DOWN on its own face. A button that merely goes dead gets pressed harder, not
 * later; one that says "Start video in 6s" explains itself and tells staff the
 * wait is deliberate and nearly over.
 *
 * DESK-ONLY, AND DELIBERATELY NOT ENFORCED SERVER-SIDE. The room state, the API
 * and the TV are untouched: this is a habit-shaping pause, not an invariant, and a
 * genuine reason to start early is ten seconds away rather than blocked outright.
 *
 * ONLY THE FIRST START IS HELD. Restart is for latecomers to a group already sat
 * in the room, so holding it would delay the one press that is never premature.
 */
import type { BriefingRoomState } from "./types";

/**
 * How long Start is held after a send.
 *
 * Ten seconds is the owner's number, and it is the right shape: long enough to
 * break a two-press reflex at the desk, short enough that staff wait it out rather
 * than learning to route around it.
 */
export const START_HOLD_MS = 10_000;

/**
 * How much of the hold is left, in ms. 0 means Start is live.
 *
 * Reads the room's own send stamp rather than a local timer, so the hold survives
 * the scan flash, a reload, and a second desk looking at the same room — every
 * board agrees on when the ten seconds are up.
 *
 * Anything it cannot make sense of returns 0: an unknown state must never be the
 * thing that stops a room starting its safety video.
 */
export function startHoldRemainingMs(
  state: Pick<BriefingRoomState, "kind" | "triggeredAtMs"> | null | undefined,
  nowMs: number,
): number {
  // `assigned` is the only phase with an unstarted film behind it. A timeline is
  // already running (Restart), and no state means there is nothing to start.
  if (!state || state.kind !== "assigned") return 0;
  if (!Number.isFinite(state.triggeredAtMs) || !Number.isFinite(nowMs)) return 0;

  const remaining = state.triggeredAtMs + START_HOLD_MS - nowMs;
  if (remaining <= 0) return 0;
  // CLAMPED TO THE HOLD ITSELF, because `triggeredAtMs` is the SERVER's stamp
  // while `nowMs` is the desk PC's clock — the same skew briefingTimelineAt
  // already guards the other way. A desk running a minute behind would otherwise
  // hold Start for seventy seconds; clamping bounds the wait to the skew and keeps
  // the button from ever counting down from more than ten.
  return Math.min(START_HOLD_MS, remaining);
}

/**
 * Whole seconds left, for the button face.
 *
 * Ceiled, so a hold with 200ms to run still reads 1 — a button showing 0 that
 * does nothing when pressed is worse than one showing 1.
 */
export function startHoldSeconds(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}
