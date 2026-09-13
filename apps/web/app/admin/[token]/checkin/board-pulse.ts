/**
 * THE DESK BOARD'S FAST LANE — the PURE half. No React, no fetch: a full board
 * and a pulse in, one board out, so the merge rule is a test rather than a
 * thing to reproduce on a race night.
 *
 * WHY THE BOARD IS SPLIT (owner 2026-09-12: "show them available as soon as
 * race is posted"). The full status folds the day's assignments and events out
 * of Neon and cannot honestly run every two seconds; the rooms, the lanes and
 * the Track Ops crew are Redis reads and change at a PRESS — send, start, send
 * to holding, post. So `/api/admin/briefing?pulse=1` carries those three at 2s
 * and this merges them over the 5s board, exactly as useTvFeed merges the TV
 * pulse over the TV feed.
 *
 * THE THREE MOVE TOGETHER. A pulse that carried only the lanes would show a
 * group in the Holding box two seconds before its room box emptied — one group
 * in two places — which is precisely the disagreement the crew fold was built
 * to rule out between the strip and the boxes.
 *
 * NEWER WINS, BY THE SERVER'S CLOCK. A press does `loadBoard()` and lands a
 * fresh full status; a pulse read a moment BEFORE that press must not overwrite
 * it, so a pulse is applied only when its `now` is later than the board's.
 * Both stamps are the same server's `Date.now()`, so the comparison is fair.
 *
 * `groupOut` STAYS FROM THE FULL BOARD. It needs the day's assignments, which
 * the pulse deliberately does not read; a room's last-group-out changes at a
 * send, and every send is followed by a full reload anyway.
 */
import type { PitLanes } from "~/features/signage/pit/pit-board";
import type { CrewBoard } from "~/features/staff/crew-list";
import type { BoardStatus, RoomStatus } from "./useBriefingControl";

/** Mirrors BriefingBoardPulse in ~/features/signage/briefing/service.ts. */
export interface BoardPulse {
  now: number;
  rooms: Array<Omit<RoomStatus, "groupOut">>;
  lanes: PitLanes;
  crew: CrewBoard;
}

export function mergeBoardPulse(
  board: BoardStatus | null,
  pulse: BoardPulse | null | undefined,
): BoardStatus | null {
  if (!board) return null;
  if (!pulse || !(pulse.now > board.now)) return board;
  const pulseRooms = new Map(pulse.rooms.map((r) => [r.room, r]));
  return {
    ...board,
    now: pulse.now,
    rooms: board.rooms.map((full) => {
      const fast = pulseRooms.get(full.room);
      return fast ? { ...full, ...fast, groupOut: full.groupOut } : full;
    }),
    lanes: pulse.lanes,
    crew: pulse.crew,
  };
}

/**
 * WHO IS WHERE, as one string — the board's cue to refetch the wait times.
 *
 * The Wait times panel is a Neon fold polled on a slow cadence, and its numbers
 * move when a GROUP moves: a race goes green (room → race lands), a race is
 * posted (total experience lands). Both are lane events. Comparing this between
 * polls and refetching on a change is what makes "Total experience" appear the
 * moment a race is posted rather than up to a poll interval later.
 *
 * Session ids per slot per track, in a fixed order, so two reads of the same
 * floor always produce the same string. Empty lanes → "".
 */
export function laneSignature(lanes: PitLanes | null | undefined): string {
  if (!lanes) return "";
  const parts: string[] = [];
  for (const track of ["blue", "red", "mega"] as const) {
    const lane = lanes[track];
    if (!lane) continue;
    for (const slot of ["holding", "karts", "racing", "pitIn"] as const) {
      const id = lane[slot]?.sessionId;
      if (id) parts.push(`${track}:${slot}:${id}`);
    }
  }
  return parts.join("|");
}
