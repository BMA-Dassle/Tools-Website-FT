/**
 * A SEND REACHES THE CHECK-IN WALLS ON THE FAST LANE, like every other press.
 *
 * "Send to blue" writes two things: the ROOM's state, and a `briefed` marker
 * against the session. The room's state has ridden the 2-second pulse since the
 * rooms went in — a group is walking to it, so the wall in front of them cannot
 * wait. The marker rides the 15-second full feed, because it is folded into
 * `raceCheckin` server-side alongside the party board, the VIP roster and the
 * heat's count, which touch Neon and BMI.
 *
 * But the marker is what CLEARS THE CHECK-IN BOARD — `briefedAtMs` is the only
 * signal the check-in scenes have that a heat has been handed over, and it is
 * what fires the "proceed to the RED room" announcement over it. So staff
 * pressed Send, the briefing room lit up within two seconds, and the check-in
 * wall next to it went on showing the same heat, the same names and the same
 * count for up to fifteen seconds more.
 *
 * Nothing new is read to fix that. The pulse ALREADY carries both rooms, and a
 * room state names the session it is holding. If a room is holding this heat,
 * this heat has been sent — that is the same fact the marker records, arriving
 * thirteen seconds earlier.
 *
 * THE SERVER'S MARKER ALWAYS WINS where it exists. This only fills the gap
 * before the next full poll, and never overrides a time the server has already
 * stated.
 *
 * ONLY THE `assigned` PHASE COUNTS. `triggeredAtMs` is the send time while a
 * room is holding a group, and becomes the START time the moment staff press
 * Start — reading it after that would jump the stamp forward and re-fire the
 * "proceed to the RED room" announcement minutes late, over a group already
 * watching the film. By then the real marker has long since arrived on the full
 * feed anyway: the walk to a room outlasts a 15-second poll every time.
 *
 * UNDO IS SAFE. `clearRoom` clears the room state before it clears the marker,
 * so an undone send leaves no room holding the session and nothing here to
 * synthesise — the heat returns to the check-in board exactly as it did before.
 */

import { BRIEFING_ROOMS, type BriefingRoom, type BriefingRoomState } from "./types";

/** Both rooms as the pulse carries them; null when they could not be read. */
export type RoomStates = Partial<Record<BriefingRoom, BriefingRoomState | null>> | null;

/** What a feed row carrying a send marker looks like, from here. */
export interface BriefedMarked {
  briefedAtMs: number | null;
  briefedRoom: "red" | "blue" | null;
}

/** The rooms currently HOLDING a group whose film has not been started. */
function holdingRooms(rooms: RoomStates): Array<[BriefingRoom, BriefingRoomState]> {
  if (!rooms) return [];
  const out: Array<[BriefingRoom, BriefingRoomState]> = [];
  for (const room of BRIEFING_ROOMS) {
    const state = rooms[room];
    if (state && state.kind === "assigned") out.push([room, state]);
  }
  return out;
}

/**
 * The track board's heat, marked as sent the moment a room says it is holding
 * it. Matched on SESSION ID — the precise identity, and the one the send is
 * keyed on.
 */
export function briefedFromRoomsBySession<
  T extends BriefedMarked & { sessionId: number | string | null },
>(row: T | null, rooms: RoomStates): T | null {
  if (!row || row.briefedAtMs !== null || row.sessionId == null) return row;
  const sid = String(row.sessionId);
  for (const [room, state] of holdingRooms(rooms)) {
    if (state.sessionId === sid) {
      return { ...row, briefedAtMs: state.triggeredAtMs, briefedRoom: room };
    }
  }
  return row;
}

/**
 * The same, for the guide wall's rows.
 *
 * MATCHED ON TRACK AND HEAT NUMBER, not on the session id, because the guide
 * wall's payload deliberately carries no ids at all — it serves a wall in a
 * public space (see TvFeed.raceGuide). Heat numbers are per-track, so the pair
 * identifies a heat for the day as precisely as the id would.
 */
export function briefedFromRoomsByHeat<
  T extends BriefedMarked & { track: string; heatNumber: number | null },
>(rows: T[], rooms: RoomStates): T[] {
  const holding = holdingRooms(rooms);
  if (holding.length === 0) return rows;
  return rows.map((row) => {
    if (row.briefedAtMs !== null || row.heatNumber == null) return row;
    for (const [room, state] of holding) {
      if (state.track === row.track && state.heatNumber === row.heatNumber) {
        return { ...row, briefedAtMs: state.triggeredAtMs, briefedRoom: room };
      }
    }
    return row;
  });
}
