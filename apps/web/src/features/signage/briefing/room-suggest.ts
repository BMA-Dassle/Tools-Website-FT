/**
 * WHICH ROOM THE NEXT MEGA SEND SHOULD GO TO, and which room the race on track
 * is coming back to. PURE — the lane and the free rooms in, one room out.
 *
 * ONE CIRCUIT, TWO ROOMS, and everything awkward about a Mega night follows
 * from that. The rooms are meant to leapfrog: one briefs while the other holds
 * a group's kit handover, and a desk that sends two heats into the same room in
 * a row spends the evening waiting on it.
 *
 * BOTH ANSWERS HERE ARE THE SAME FACT SEEN FROM TWO SIDES — the room the lane
 * is spoken for by. The suggestion says "not that one"; the late-send warning
 * says "that one". They lived as two inline expressions in the check-in board
 * and disagreed, which is how the desk ended up suggesting the very room a race
 * was walking back into (owner 2026-08-18: "wouldn't the room they're not
 * returning to be the suggested?").
 *
 * A SUGGESTION, NEVER A RULE (owner 2026-08-16: auto-suggest, staff confirms).
 * The press is still the assignment and the other room's button always works —
 * nothing here may refuse a send.
 */
import type { BriefingRoom } from "./types";
import type { PitLaneFeed } from "../pit/pit-board";

/**
 * THE ROOM THE LANE IS COMING BACK TO — who is out on track, or already in the
 * pit waiting on their post-race announcement.
 *
 * A group walks back into the room they were briefed in to hand helmets and
 * cameras over (welcome-back.ts), and their announcement will not play into a
 * room holding a film (postRaceGate, pit/audio.server.ts). So this room is
 * spoken for, by people who have not walked back into it yet.
 *
 * DELIBERATELY NOT the seats or the karts. Those groups have left their room
 * behind and will not be back for a race yet — the room they came from is free
 * to take the next heat, which is the whole reason the rooms leapfrog.
 *
 * Null when nothing is out, and null when the group out there carries no room:
 * a group placed on track by hand from Override has none to copy, and a room
 * this cannot name must never be guessed at — the callers each say what they do
 * with "unknown", and neither of them may point at the wrong door.
 */
export function laneReturnRoom(lane: PitLaneFeed | null | undefined): BriefingRoom | null {
  return lane?.racing?.room ?? lane?.pitIn?.room ?? null;
}

/**
 * THE ROOM THAT MOST RECENTLY HAD A GROUP IN IT, latest first.
 *
 * Wider than `laneReturnRoom` on purpose: for "who went last" a group sitting
 * in the seats counts, because they were briefed after everybody ahead of them.
 * The order is the journey backwards — holding, karts, on track, pit.
 *
 * `racing` was missing from this chain until 2026-08-18, when the lane's wire
 * shape started carrying the room through the race. The fourteen minutes a heat
 * is out is the longest a group is anywhere, and through all of it the board
 * read "nobody has taken a room tonight".
 */
export function lastRoomUsed(lane: PitLaneFeed | null | undefined): BriefingRoom | null {
  return (
    lane?.holding?.room ?? lane?.karts?.room ?? lane?.racing?.room ?? lane?.pitIn?.room ?? null
  );
}

export interface MegaRoomSuggestion {
  /** The rooms that are idle right now — the caller owns the phase test. */
  free: readonly BriefingRoom[];
  /** The one combined lane a Mega night runs. */
  lane: PitLaneFeed | null;
}

/**
 * WHERE THE NEXT GROUP SHOULD GO.
 *
 * THE FREE ROOM TAKES THE HEAT. With one room free that is the answer whatever
 * else is true — the alternative is interrupting a film, which is a Replace and
 * a human call.
 *
 * WITH BOTH FREE, THE ONE THAT DID NOT TAKE THE LAST GROUP. That is the
 * leapfrog, and the room the last group used is also the room they are walking
 * back into when they are the ones on track.
 *
 * BOTH BUSY IS NO SUGGESTION. Every send from there is a Replace, and which
 * film to interrupt is not a thing a chip should have an opinion about.
 *
 * NOTHING KNOWN FALLS TO RED, as it always has: with no group anywhere tonight
 * either room is equally right, and a board that suggested nothing at the start
 * of the evening would teach staff the chip is unreliable.
 */
export function suggestMegaRoom(input: MegaRoomSuggestion): BriefingRoom | null {
  const free = input.free;
  if (free.length === 0) return null;
  if (free.length === 1) return free[0];
  const last = lastRoomUsed(input.lane);
  if (last === "red") return "blue";
  if (last === "blue") return "red";
  return "red";
}
