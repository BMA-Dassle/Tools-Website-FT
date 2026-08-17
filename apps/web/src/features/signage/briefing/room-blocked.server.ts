import "server-only";

/**
 * WHICH ROOM IS HOLDING UP A RACE THAT IS ALREADY BACK — resolved once per
 * pulse, for both rooms, from facts the pulse is holding anyway.
 *
 * The verdict itself is `postRaceGateFrom` (pit/audio.server.ts) — the very rule
 * that dark-ens the pit station's Play Post button. Nothing here re-decides it;
 * this only finds the races to ask about and addresses the answers to rooms.
 *
 * ONE EXTRA REDIS READ, AND ONLY WHEN A RACE IS ACTUALLY IN THE PIT. The rooms
 * are passed in (the pulse has already MGET them for the wall), so the only new
 * cost is `sessionBriefed` per occupied `pitIn` slot — at most three GETs, and
 * on a quiet track exactly zero. That matters because this rides the 2-second
 * pulse, which is deliberately "a fixed handful of Redis reads no matter how
 * many screens are hanging" (see buildTvPulse).
 *
 * WHY `sessionBriefed` RATHER THAN THE LANE'S OWN `pitIn.room`: the lane slot
 * can carry a null room — a group placed by hand from Override has nothing to
 * copy one from — while the briefed marker still knows which room they came out
 * of. `postRaceGate` reads the marker, so reading anything else here would let
 * the wall go quiet while the button stayed refused. See the note on
 * PitWaitingRace in room-blocked.ts.
 *
 * THE LONGEST WAIT WINS when two tracks are stuck behind one room — a real
 * shape on a Mega night, where both circuits return into whichever room is
 * open. There is one screen and one line of copy for it, so it names the group
 * that has been standing in the pit in their gear the longest.
 */
import { postRaceGateFrom } from "../pit/audio.server";
import type { PitLanes } from "../pit/pit-board";
import type { PitWaitingRace } from "./room-blocked";
import { sessionBriefed } from "./state.server";
import type { BriefingRoom, BriefingRoomState } from "./types";

export type RoomBlockedFeed = Record<BriefingRoom, PitWaitingRace | null>;

const NONE: RoomBlockedFeed = { red: null, blue: null };

export async function resolveRoomBlocked(
  rooms: Record<BriefingRoom, BriefingRoomState | null>,
  lanes: PitLanes,
): Promise<RoomBlockedFeed> {
  // No room is occupied ⇒ nothing can be blocked, and we can skip the reads
  // entirely. The common case on a quiet evening.
  if (!rooms.red && !rooms.blue) return NONE;

  const waiting = (["blue", "red", "mega"] as const)
    .map((track) => lanes[track]?.pitIn ?? null)
    .filter((slot): slot is NonNullable<typeof slot> => slot != null);
  if (waiting.length === 0) return NONE;

  const out: RoomBlockedFeed = { red: null, blue: null };
  // Oldest arrival first — see the header. The first race to claim a room is
  // the one that has been waiting longest, and it keeps it.
  const ordered = [...waiting].sort((a, b) => a.atMs - b.atMs);

  for (const slot of ordered) {
    const briefed = await sessionBriefed(slot.sessionId).catch(() => null);
    const gate = postRaceGateFrom(briefed?.room ?? null, rooms);
    if (gate.allowed) continue;
    for (const room of gate.blockedRooms) {
      // The longest wait stands: `ordered` is oldest-first, so only fill a room
      // that nothing older has already claimed.
      if (out[room] == null) out[room] = { heatNumber: slot.heatNumber };
    }
  }

  return out;
}
