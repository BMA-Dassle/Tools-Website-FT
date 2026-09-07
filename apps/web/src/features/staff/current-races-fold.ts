/**
 * WHICH RACE EACH MARSHAL IS ON RIGHT NOW — the PURE half.
 *
 * Facts in (the pit lanes, the briefing rooms, and who claimed which session),
 * one row per person out. No Redis, no fetch, no clock read: everything here is
 * arithmetic over what the caller hands in, which is what makes the ranking
 * rule below testable rather than something you have to reproduce on a race
 * night to check.
 *
 * WHY A PERSON CAN HOLD TWO SESSIONS AT ONCE, and why that is normal rather
 * than a bug to reject: a marshal who has just walked one group out to the
 * karts is claimed on that session until it pits in, and the desk may already
 * have sent them the next group in a briefing room. Both claims are true. The
 * pill on the wall has room for one, so it names the group that is FURTHEST
 * ALONG — the one whose next event happens soonest and whose racers are
 * strapped into a kart.
 *
 * EXCEPT PIT IN, WHICH RANKS LAST (owner 2026-09-07). A group in the pit is
 * leaving: the karts are back, the post-race announcement is owed, and the
 * marshal's attention has already moved to whatever they have staged behind it.
 * Ranking it above a briefing would tag somebody with the race they have just
 * finished while a room full of people waits for them.
 */
import { briefingTimelineAt } from "../signage/briefing/phase";
import type { BriefingRoom, BriefingRoomState } from "../signage/briefing/types";
import type { PitLanes } from "../signage/pit/pit-board";
import type { TrackKey } from "../signage/track";

/** Where a group is. The five places a session can be claimed from. */
export type RaceStage = "briefing" | "holding" | "karts" | "racing" | "pitIn";

/** One occupied slot, before it is joined to whoever claimed it. */
export interface RaceOccupancy {
  sessionId: string;
  track: TrackKey;
  heatNumber: number | null;
  stage: RaceStage;
}

/** One marshal and the single group they are running. */
export interface StaffRace {
  /** 7shifts USER id — the join key, never the punch ID (which is reissued). */
  userId: number;
  firstName: string;
  sessionId: string;
  track: TrackKey;
  heatNumber: number | null;
  stage: RaceStage;
}

/**
 * HOW FAR ALONG EACH STAGE IS. Higher wins when one person holds two.
 *
 * Read it as "how soon does this group need them": on track and in the karts
 * are live, holding is next out of the gate, a briefing is minutes away, and a
 * group in the pit is done. See the header for why `pitIn` is at the bottom
 * rather than the top.
 */
export const STAGE_RANK: Record<RaceStage, number> = {
  racing: 4,
  karts: 3,
  holding: 2,
  briefing: 1,
  pitIn: 0,
};

/** The four lane slots, in the order they are declared on the feed. */
const LANE_SLOTS = ["holding", "karts", "racing", "pitIn"] as const;

const TRACKS: readonly TrackKey[] = ["blue", "red", "mega"] as const;

/**
 * Every occupied lane slot across the three tracks.
 *
 * The lane is the authority on where a group physically is — it is written by
 * the two staff presses at the pit and by the timing system's own markers, so
 * unlike the desk's called record it cannot describe a group that has moved on.
 */
export function laneOccupancies(lanes: PitLanes | null | undefined): RaceOccupancy[] {
  if (!lanes) return [];
  const out: RaceOccupancy[] = [];
  for (const track of TRACKS) {
    const lane = lanes[track];
    if (!lane) continue;
    for (const stage of LANE_SLOTS) {
      const held = lane[stage];
      if (!held?.sessionId) continue;
      out.push({
        sessionId: held.sessionId,
        track,
        heatNumber: held.heatNumber ?? null,
        stage,
      });
    }
  }
  return out;
}

/**
 * The briefing rooms, when they are actually running a briefing.
 *
 * THE IDLE TEST IS THE SAME ONE THE STAGE RAIL USES, and it matters here more
 * than it does there. A room's Redis key survives an abandoned send for
 * forty-five minutes (ASSIGNED_HOLD_MS), so without this filter a group nobody
 * ever briefed would pin a tag to that marshal for most of an evening — and
 * because a tag is what makes somebody NOT available, it would also hide them
 * from the front of the Track Ops list for that long. A stale key must cost
 * nothing.
 *
 * The TRACK comes from the room's own state, never from the room's name: on a
 * Mega night the red room briefs into the one circuit and its groups are
 * `mega`, which is exactly the tag the wall must show.
 */
export function roomOccupancies(
  rooms: Partial<Record<BriefingRoom, BriefingRoomState | null>> | null | undefined,
  nowMs: number,
): RaceOccupancy[] {
  if (!rooms) return [];
  const out: RaceOccupancy[] = [];
  for (const state of Object.values(rooms)) {
    if (!state?.sessionId) continue;
    if (briefingTimelineAt(state, nowMs).phase === "idle") continue;
    out.push({
      sessionId: state.sessionId,
      track: state.track,
      heatNumber: state.heatNumber ?? null,
      stage: "briefing",
    });
  }
  return out;
}

/**
 * Join occupied slots to whoever claimed them, one row per PERSON.
 *
 * An occupancy nobody claimed is dropped rather than reported as an anonymous
 * race: this feeds a list of people, and a row with no name is a row nobody can
 * act on. (The count of unclaimed GROUPS is reported separately, by the
 * briefing counts — see crew-list.)
 *
 * Ties on rank keep the first occupancy seen, so the output is stable between
 * polls: the caller's lane order does not change within a night, and a pill
 * that swapped its tag every two seconds between two equally-ranked groups
 * would be unreadable.
 */
export function foldCurrentRaces(
  occupancies: readonly RaceOccupancy[],
  hosts: Readonly<Record<string, { userId: number; firstName: string }>>,
): StaffRace[] {
  const byUser = new Map<number, StaffRace>();
  for (const occ of occupancies) {
    const host = hosts[occ.sessionId];
    if (!host) continue;
    const held = byUser.get(host.userId);
    if (held && STAGE_RANK[held.stage] >= STAGE_RANK[occ.stage]) continue;
    byUser.set(host.userId, {
      userId: host.userId,
      firstName: host.firstName,
      sessionId: occ.sessionId,
      track: occ.track,
      heatNumber: occ.heatNumber,
      stage: occ.stage,
    });
  }
  // Sorted so the endpoint's `active[]` and any log of it read the same way
  // twice — Map insertion order would leak the caller's read order onto a
  // public contract.
  return [...byUser.values()].sort(
    (a, b) => STAGE_RANK[b.stage] - STAGE_RANK[a.stage] || a.firstName.localeCompare(b.firstName),
  );
}
