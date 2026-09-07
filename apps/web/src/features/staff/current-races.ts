import "server-only";

/**
 * WHICH RACE EACH MARSHAL IS ON RIGHT NOW — the reading half.
 *
 * Three Redis reads and a fold. Nothing is written, and nothing new is stored:
 * every fact here already exists because the pit boards need it. The lanes say
 * where each group is, the room keys say who is being briefed, and
 * `staff:session-host:*` says who claimed each session at the tablet.
 *
 * NEVER THROWS. This decorates a list of people on a wall; a Redis blip must
 * cost the tags and nothing else. Every read swallows to empty and the caller
 * gets `[]`, which renders as "nobody is hosting" — the same thing a quiet
 * moment looks like, and strictly better than a board that fails to paint.
 *
 * TWO ENTRY POINTS, ONE FOLD. `currentStaffRaces` reads for itself, for callers
 * that hold nothing (the portal endpoint). `currentStaffRacesFrom` takes lanes
 * and rooms the caller ALREADY read, for the two that do — the check-in board
 * polls every five seconds and the TV feed every fifteen, and both had the
 * lanes and the rooms in hand before this feature existed. Re-reading them here
 * would have doubled the busiest Redis path in the building to save one
 * argument.
 */
import { readBriefingRooms } from "../signage/briefing/state.server";
import type { BriefingRoom, BriefingRoomState } from "../signage/briefing/types";
import { readPitLanes } from "../signage/pit/lane.server";
import type { PitLanes } from "../signage/pit/pit-board";
import { readSessionHosts } from "./session-host";
import { foldCurrentRaces, laneOccupancies, roomOccupancies } from "./current-races-fold";
import type { StaffRace } from "./current-races-fold";

export type { RaceStage, StaffRace } from "./current-races-fold";

/** Only FastTrax has briefing rooms and a pit lane. */
const VENUE = "FT";

/**
 * The fold, over lanes and rooms the caller already holds.
 *
 * ONE `mget` for the hosts however many slots are occupied — a per-session read
 * would be up to fourteen Redis calls on a five-second poll.
 */
export async function currentStaffRacesFrom(input: {
  lanes: PitLanes | null;
  rooms: Partial<Record<BriefingRoom, BriefingRoomState | null>> | null;
  nowMs: number;
}): Promise<StaffRace[]> {
  const occupancies = [
    ...laneOccupancies(input.lanes),
    ...roomOccupancies(input.rooms, input.nowMs),
  ];
  if (!occupancies.length) return [];
  const hosts = await readSessionHosts(occupancies.map((o) => o.sessionId)).catch(() => ({}));
  return foldCurrentRaces(occupancies, hosts);
}

/** The same answer for a caller with nothing in hand. Two MGETs plus the hosts. */
export async function currentStaffRaces(nowMs: number = Date.now()): Promise<StaffRace[]> {
  try {
    const [lanes, rooms] = await Promise.all([
      readPitLanes().catch(() => null),
      readBriefingRooms(VENUE).catch(() => null),
    ]);
    return await currentStaffRacesFrom({ lanes, rooms, nowMs });
  } catch (err) {
    // ONE line, not one per row: this runs on every poll of every board, and a
    // Redis outage that logged per session would bury everything else.
    console.warn("[current-races] could not read the floor:", err);
    return [];
  }
}
