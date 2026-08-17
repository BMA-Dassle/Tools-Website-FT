/**
 * IS THIS ROOM HOLDING UP A RACE THAT IS ALREADY BACK? PURE — facts in, one
 * verdict out.
 *
 * WHY THIS EXISTS (owner 2026-08-16: "when a race is waiting in pit because the
 * briefing room is occupied, as long as we have shown helmets for 30 seconds,
 * flash a red full screen alert that a race is waiting in pit").
 *
 * The rule it makes visible is not a new one — it is `postRaceGate`, which has
 * refused to play the post-race announcement into an occupied room since
 * 2026-08-14 ("post-race is only possible if the briefing room is empty"). That
 * announcement is what calls a finished race back in to hand kit over, so while
 * a room is busy the group sits in the pit in their gear and the pit station's
 * Play Post button is dark with `red room busy` printed on it.
 *
 * THE DESK KNEW AND THE ROOM DID NOT. Everyone who could shorten that wait was
 * standing in the one place the refusal was never shown. This puts the same
 * verdict on the room's own wall.
 *
 * ─── WHAT IT DOES NOT DO ─────────────────────────────────────────────────
 *
 * It does not free the room, and the copy must not pretend otherwise. Nobody
 * walks out of a briefing room unescorted (owner 2026-08-16: "it can't say leave
 * room now — it can say helmet up and wait for a track marshal"), so the alert
 * asks for the only thing the room can actually do: be helmeted and standing.
 * What that buys is the handover — a group already up is a twenty-second
 * walk-out instead of a two-minute one.
 *
 * ─── WHY THE GATE IS THE HELMET BOARD, NOT THE FILM'S END ────────────────
 *
 * Same reasoning as auto-holding.ts: the film is a safety briefing and the
 * helmet board is how a group learns what to put on. Firing across either would
 * be shouting at people doing exactly what they were told to do. The alert may
 * only appear once the board has had the full 30 seconds it is given — and
 * `helmetBoardComplete` (phase.ts) is that question's one implementation.
 *
 * A ROOM ON `waiting` IS SILENT, deliberately, and it is the one gap worth
 * naming. That is a group sent in whose film nobody started: the room is just as
 * full and the race in the pit just as stuck, but "helmet up" would be telling
 * people to gear up before they have seen the safety briefing. The desk already
 * warns on that case at 3 and 5 minutes (desk-alerts.ts); it is not this
 * screen's to answer.
 */
import { briefingTimelineAt, helmetBoardComplete } from "./phase";
import type { BriefingRoomState } from "./types";

/**
 * The race sitting in the pit that this room is holding up, as the server
 * resolved it.
 *
 * RESOLVED SERVER-SIDE, NEVER RE-DERIVED HERE. It is tempting to read the lane's
 * own `pitIn.room` on the wall and skip a round trip — but `postRaceGate`
 * decides the room from `sessionBriefed`, and the two can disagree: a lane slot
 * written by hand from Override carries no room at all, while the briefed marker
 * still knows exactly which room that group came out of. A wall reading the
 * emptier of the two facts would go quiet while the button stayed refused, which
 * is precisely the drift holding-availability.ts and briefingReadyForHolding
 * exist to prevent. One gate, asked once, shipped to both.
 */
export interface PitWaitingRace {
  /** For the copy — "Session 42 is back". Null for a group event or a custom
   *  race, and the alert then simply says a race rather than naming one. */
  heatNumber: number | null;
}

export interface RoomBlockedInput {
  /** The room's live display state. Null when the room is idle. */
  state: BriefingRoomState | null | undefined;
  /** What the server says is waiting on THIS room, or null when nothing is. */
  waiting: PitWaitingRace | null | undefined;
  nowMs: number;
}

/** Null = say nothing. There is no "warn" level here on purpose: either a race
 *  is stuck behind this room or it is not, and a half-alert on a wall a guest is
 *  sitting in front of is worse than none. */
export interface RoomBlockedAlert {
  heatNumber: number | null;
}

export function roomBlockedAlertAt(input: RoomBlockedInput): RoomBlockedAlert | null {
  const { state, waiting, nowMs } = input;
  // Nothing is waiting, or the room is idle and therefore blocking nobody. An
  // idle room is the normal state and the gate it would fail does not exist.
  if (!waiting || !state) return null;
  // The film, then the board's own 30 seconds. Both live in one place.
  if (!helmetBoardComplete(state, briefingTimelineAt(state, nowMs), nowMs)) return null;
  return { heatNumber: waiting.heatNumber };
}
