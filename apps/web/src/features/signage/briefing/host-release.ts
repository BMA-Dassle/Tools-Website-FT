/**
 * SHOULD A GROUP LEAVING A ROOM GIVE ITS HOST BACK? The PURE rule.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Hosting is claimed with NX — first press wins — and had no way out. That is
 * right for a stray press and wrong for a mistake: a group pulled into the wrong
 * room kept the mistaken presser as their host for 24 hours, so whoever then
 * ACTUALLY briefed them pressed Start, the NX quietly refused, and the pit board
 * named the wrong person all night. Track staff reported it as a group "taking
 * the last person's assignment".
 *
 * Two presses undo a mis-pull — Undo (clearRoom) and a replacing send — and both
 * ask this same question, which is why it is one function and not two copies.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * THE FILM IS THE LINE. Once the safety video has rolled, the person who started
 * it BRIEFED that group; that is the exact claim the insurance log makes about
 * them, and they keep the attribution wherever the group goes next. Before it
 * rolls nothing has happened yet — a pull is a button press, and an undone press
 * should leave no trace.
 *
 * `waiting` (assigned, not started) and `idle` (an assignment that timed out
 * unstarted) are precisely the phases a room can be in without a Start;
 * `video` and `helmet` are unreachable without one. So the phase IS the
 * question, asked in the timeline's own words rather than by peeking at
 * `state.kind` — one source of truth for "what is this room doing".
 *
 * MEGA IS THE CARVE-OUT, and it is not theoretical: on a Mega night one session
 * is legitimately in BOTH rooms under ONE host, and clearing one of them must
 * not blank the name the other room is still running under. Same question
 * `clearRoom` already asks before it un-briefs a session.
 */
import type { BriefingPhase } from "./types";

export interface HostReleaseArgs {
  /** The session leaving the room. Nothing to release without one. */
  sessionId: string | null | undefined;
  /** What the room they are leaving was doing — `briefingTimelineAt().phase`. */
  phase: BriefingPhase;
  /**
   * Sessions in the OTHER briefing rooms right now. The caller passes every room
   * except the one being left, so a Mega group still next door is visible here.
   */
  otherRoomSessionIds: (string | null | undefined)[];
}

/**
 * True when the host claim should be deleted outright.
 *
 * RELEASE, NEVER REASSIGN — at the moment a mis-pull is undone there is nobody
 * to name, because the real briefer has not touched a tablet yet. A free key
 * makes their next press the first press, which is what it should have been.
 * (A deliberate hand-over is the other door: see handOverSessionHost.)
 */
export function releasesHostOnExit(args: HostReleaseArgs): boolean {
  if (!args.sessionId) return false;
  if (args.phase === "video" || args.phase === "helmet") return false;
  return !args.otherRoomSessionIds.some((id) => !!id && id === args.sessionId);
}
