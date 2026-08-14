import "server-only";

/**
 * The pit lane's state — who is seated, who is racing, and whether the lane
 * is safe. Written by two staff presses on the check-in station and read by
 * the pit boards on the 2-second pulse.
 *
 * THE TWO PRESSES (owner 2026-08-13):
 *
 *   SEND TO HOLDING — after the briefing. The group leaves the room for the
 *   pit seats, which FREES THE ROOM (a race can only return to a room with
 *   nobody briefing in it) and tells the board its group is seatable. The
 *   room's occupancy is closed in the insurance log with reason "holding";
 *   the check-in board's briefed marker is deliberately LEFT ALONE — unlike
 *   clearRoom, this send must not put the heat back on the check-in wall.
 *
 *   RACE RETURNED (pitted) — the finished race's karts are fully back in the
 *   lane. THIS is what releases the board's hold: a race finishing starts the
 *   hold automatically (the venue's own finish marker), but only a human who
 *   can see the lane says when it is safe again. Never a timer.
 *
 * WHO IS RACING IS DERIVED, NEVER SWEPT. The stored state only records what
 * staff said ("this session is in holding"); whether that session has since
 * green-flagged is answered at read time by the RaceStart marker the timing
 * webhook writes. A crash between the flag and a poll therefore costs
 * nothing — the next read resolves the same answer from the same facts.
 *
 * Same posture as briefing/state.server.ts: Neon rows first (the record),
 * Redis second (the display), and every export swallows — a Redis blip may
 * cost a wall animation, never a staff action that already wrote its row.
 */
import redis from "@/lib/redis";
import { businessDayYmdET } from "@/lib/race-business-day";
import { recordBriefingEvent } from "../briefing/events-db";
import { readRaceFinishedMarker } from "../briefing/race-finish.server";
import { clearBriefingRoom, sessionBriefed } from "../briefing/state.server";
import type { BriefingRoom } from "../briefing/types";
import type { TrackKey } from "../track";
import { EMPTY_PIT_LANE, type PitLaneFeed, type PitLanes } from "./pit-board";

const VENUE = "FT";
const PIT_TRACKS: TrackKey[] = ["blue", "red", "mega"];

/** Outlives any race night; short enough that Redis stays display state. */
const LANE_TTL_SECONDS = 12 * 3600;

/** What staff said, verbatim. The resolved view (PitLaneFeed) is computed
 *  from this plus the start/finish markers at read time. */
interface StoredPitLane {
  holding: {
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    room: BriefingRoom | null;
    atMs: number;
  } | null;
  racing: {
    sessionId: string;
    heatNumber: number | null;
    room: BriefingRoom | null;
  } | null;
  /** The staff "race returned" stamp, tied to the session it answered. */
  pitted: { sessionId: string; atMs: number } | null;
}

function laneKey(track: TrackKey): string {
  return `pit:lane:${VENUE}:${track}`;
}

async function readStoredLane(track: TrackKey): Promise<StoredPitLane | null> {
  try {
    const raw = await redis.get(laneKey(track));
    return raw ? (JSON.parse(raw) as StoredPitLane) : null;
  } catch {
    return null;
  }
}

async function writeStoredLane(track: TrackKey, lane: StoredPitLane): Promise<void> {
  try {
    await redis.set(laneKey(track), JSON.stringify(lane), "EX", LANE_TTL_SECONDS);
  } catch {
    /* the durable event row is already written — see the header */
  }
}

/**
 * Resolve a stored lane to what is true now: a holding group whose start
 * marker has landed IS the racing group, whatever the stored state says.
 */
async function resolveLane(stored: StoredPitLane | null): Promise<PitLaneFeed> {
  if (!stored) return EMPTY_PIT_LANE;

  let holding = stored.holding;
  let racing = stored.racing;
  if (holding) {
    // HOLDING PERSISTS THROUGH THE RACE (owner 2026-08-13: "our session
    // follows the race marked in holding; green flag + active countdown moves
    // it to racing"). The start marker fires at PHASE ONE of the two-phase
    // start — karts rolling out, clock armed static, stragglers still being
    // seated — so it must NOT promote. What ends a holding claim server-side
    // is the FINISH marker (the race demonstrably ran) or the next group
    // taking the seats (see sendToHolding's displacement); the wall's own
    // holding→racing presentation is the client's counting verdict.
    const finished = await readRaceFinishedMarker(holding.sessionId).catch(() => null);
    if (finished != null) {
      racing = {
        sessionId: holding.sessionId,
        heatNumber: holding.heatNumber,
        room: holding.room,
      };
      holding = null;
    }
  }

  if (!racing) {
    return {
      holding: holding
        ? {
            sessionId: holding.sessionId,
            heatNumber: holding.heatNumber,
            raceType: holding.raceType,
            room: holding.room,
            atMs: holding.atMs,
          }
        : null,
      racing: null,
    };
  }

  const finish = await readRaceFinishedMarker(racing.sessionId).catch(() => null);
  const pittedAtMs =
    stored.pitted && stored.pitted.sessionId === racing.sessionId ? stored.pitted.atMs : null;
  return {
    holding: holding
      ? {
          sessionId: holding.sessionId,
          heatNumber: holding.heatNumber,
          raceType: holding.raceType,
          room: holding.room,
          atMs: holding.atMs,
        }
      : null,
    racing: {
      sessionId: racing.sessionId,
      heatNumber: racing.heatNumber,
      finishedAtMs: finish?.endedAtMs ?? null,
      pittedAtMs,
    },
  };
}

/** One track's resolved lane. */
export async function readPitLane(track: TrackKey): Promise<PitLaneFeed> {
  return resolveLane(await readStoredLane(track));
}

/** Every track's resolved lane — what the pulse carries. One MGET for the
 *  lanes; the marker reads happen only for tracks that actually hold state. */
export async function readPitLanes(): Promise<PitLanes> {
  const empty: PitLanes = { blue: EMPTY_PIT_LANE, red: EMPTY_PIT_LANE, mega: EMPTY_PIT_LANE };
  try {
    const raw = await redis.mget(...PIT_TRACKS.map((t) => laneKey(t)));
    const out = { ...empty };
    await Promise.all(
      PIT_TRACKS.map(async (track, i) => {
        const value = raw[i];
        if (!value) return;
        try {
          out[track] = await resolveLane(JSON.parse(value) as StoredPitLane);
        } catch {
          /* one malformed lane must not cost the other tracks */
        }
      }),
    );
    return out;
  } catch {
    return empty;
  }
}

/* ── the two staff presses ────────────────────────────────────────────── */

export interface SendToHoldingArgs {
  room: BriefingRoom;
  track: TrackKey;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
}

/**
 * Send a briefed group to the pit seats.
 *
 * ORDERING: Neon first (the room occupancy closes with reason "holding" —
 * that row is the insurance answer to "when did they leave the room"), then
 * the room's display state clears (the room is OPEN for the racing group's
 * return), then the lane records who is seatable. The briefed marker is left
 * standing so the check-in board stays cleared.
 *
 * WHO WAS RACING when this group sat down: the group these seats are being
 * taken FROM. Holding persists through the race by design (see resolveLane),
 * so a new send DISPLACES the previous holding group into racing outright —
 * staff only seat the next group once the last one is out, and succession is
 * the one start signal that needs no marker at all.
 */
export async function sendToHolding(args: SendToHoldingArgs): Promise<{ ok: true }> {
  // Durable first — the room occupancy's explicit end.
  await recordBriefingEvent({
    venue: VENUE,
    businessDay: businessDayYmdET(),
    room: args.room,
    track: args.track,
    sessionId: args.sessionId,
    heatNumber: args.heatNumber,
    raceType: args.raceType,
    tier: null,
    action: "ended",
    reason: "holding",
  });

  // The room is free the moment the group walks out of it. Deliberately NOT
  // clearRoom(): that would also un-brief the session and put the heat back
  // on the check-in wall, which is exactly wrong here.
  await clearBriefingRoom(VENUE, args.room);

  const stored = await readStoredLane(args.track);
  // Re-sending the group already in holding is a refresh, not a new cycle —
  // the racing half and its pitted stamp stay exactly as they were.
  const samePress = stored?.holding?.sessionId === args.sessionId;
  const displaced = !samePress && stored?.holding ? stored.holding : null;
  const racing = displaced
    ? {
        sessionId: displaced.sessionId,
        heatNumber: displaced.heatNumber,
        room: displaced.room,
      }
    : (stored?.racing ?? null);

  await writeStoredLane(args.track, {
    holding: {
      sessionId: args.sessionId,
      heatNumber: args.heatNumber,
      raceType: args.raceType,
      room: args.room,
      atMs: Date.now(),
    },
    racing,
    pitted:
      stored?.pitted && racing && stored.pitted.sessionId === racing.sessionId
        ? stored.pitted
        : null,
  });

  return { ok: true };
}

/**
 * "Race returned" — the karts are fully back in the lane.
 *
 * Applies to whatever the lane resolves the racing group to be. Refuses
 * (ok:false) when there is nothing to return: a stray press with an empty
 * lane must not write a stamp that would silently release the NEXT hold.
 */
/**
 * STAFF OVERRIDE — put a session in a lane slot by hand, or empty the slot.
 *
 * WHY THIS EXISTS. Every automatic transition on this board depends on
 * something outside the building: Pandora naming the called heat, the timing
 * webhook stamping a start or a finish, the live socket reaching the desk. On
 * 2026-08-13/14 all three failed in one night — Pandora's races/current
 * returned 500 for hours, start markers never arrived, finishes had to be
 * written by hand from a script — and the desk had no way to say what staff
 * could plainly see. Every correction meant somebody with a Redis client.
 *
 * So the board gets the same power the script had, with the same guard rails.
 *
 * ONE SESSION PER SLOT, ENFORCED HERE. A lane holds one group in the seats and
 * one group on track; putting a second into either would make the board lie in
 * a way staff could not see (owner 2026-08-14: "if something is already in that
 * state it would need changed first before moving another race to that state").
 * The refusal names the occupant, because "clear it first" is only actionable
 * if you know what "it" is. Refusing rather than displacing is deliberate: an
 * override is a claim about the real world, and two claims about one place mean
 * somebody is wrong and should look before overwriting.
 *
 * The stored shape is exactly what the presses write, so nothing downstream can
 * tell an override from an ordinary night.
 */
export interface LaneSlotOccupant {
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  room: BriefingRoom | null;
}

export type LaneSlot = "holding" | "racing";

export async function overrideLaneSlot(args: {
  track: TrackKey;
  slot: LaneSlot;
  /** Null empties the slot. */
  occupant: LaneSlotOccupant | null;
  /** Replace whatever is there, even a different session. The desk asks for
   *  this only after showing the staff member who is being displaced. */
  force?: boolean;
}): Promise<{ ok: boolean; error?: string; occupiedBy?: string }> {
  const stored = (await readStoredLane(args.track)) ?? {
    holding: null,
    racing: null,
    pitted: null,
  };

  const current = stored[args.slot];
  if (!args.force && args.occupant && current && current.sessionId !== args.occupant.sessionId) {
    return {
      ok: false,
      error:
        `${args.track} ${args.slot} already holds ` +
        `${current.heatNumber != null ? `session ${current.heatNumber}` : "another session"}` +
        ` — clear it first`,
      occupiedBy: current.sessionId,
    };
  }

  const next: StoredPitLane = { ...stored };
  if (args.slot === "holding") {
    next.holding = args.occupant
      ? {
          sessionId: args.occupant.sessionId,
          heatNumber: args.occupant.heatNumber,
          raceType: args.occupant.raceType,
          room: args.occupant.room,
          atMs: Date.now(),
        }
      : null;
  } else {
    next.racing = args.occupant
      ? {
          sessionId: args.occupant.sessionId,
          heatNumber: args.occupant.heatNumber,
          room: args.occupant.room,
        }
      : null;
    // A pitted stamp belongs to the session it answered. Moving a different
    // group onto the track must not inherit "their karts are already back".
    if (next.pitted && next.pitted.sessionId !== args.occupant?.sessionId) {
      next.pitted = null;
    }
  }

  await writeStoredLane(args.track, next);

  // The durable trail, so a hand-placed group is still answerable tomorrow.
  if (args.occupant) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room: args.occupant.room ?? "red",
      track: args.track,
      sessionId: args.occupant.sessionId,
      heatNumber: args.occupant.heatNumber,
      raceType: args.occupant.raceType,
      tier: null,
      action: args.slot === "holding" ? "ended" : "pitted",
      reason: "override",
    }).catch(() => {});
  }

  return { ok: true };
}

export async function markRacePitted(
  track: TrackKey,
): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
  const stored = await readStoredLane(track);
  const resolved = await resolveLane(stored);
  const racing = resolved.racing;
  if (!racing) {
    return { ok: false, error: "no race is out on that track — nothing to return" };
  }

  // The insurance row: when the group was fully back in the pit. The room on
  // the row is the room they will hand kit into — the one they were briefed
  // in — read from the lane first and the briefed marker as fallback.
  const roomFromLane =
    stored?.racing?.sessionId === racing.sessionId
      ? stored.racing.room
      : stored?.holding?.sessionId === racing.sessionId
        ? stored.holding.room
        : null;
  const room =
    roomFromLane ?? (await sessionBriefed(racing.sessionId).catch(() => null))?.room ?? null;
  if (room) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room,
      track,
      sessionId: racing.sessionId,
      heatNumber: racing.heatNumber,
      raceType: null,
      tier: null,
      action: "pitted",
    });
  }

  await writeStoredLane(track, {
    holding: stored?.holding ?? null,
    racing: stored?.racing ?? null,
    pitted: { sessionId: racing.sessionId, atMs: Date.now() },
  });
  return { ok: true, sessionId: racing.sessionId };
}
