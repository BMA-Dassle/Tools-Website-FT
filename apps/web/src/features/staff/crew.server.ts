import "server-only";

/**
 * THE TRACK OPS BOARD, ASSEMBLED — the one server-side composition behind both
 * surfaces that draw it: the check-in board's strip and the TRACK OPS row on
 * every session-status panel.
 *
 * Three inputs, three very different costs, and the caching follows the cost
 * rather than being applied evenly:
 *
 *   the RACES are Redis reads the caller already made — never cached, so a tag
 *   can never lag the Holding box six inches above it on the same screen;
 *   the COUNTS are a Neon `GROUP BY` — cached 15s, because a briefing lands
 *   about every ten minutes and the check-in board polls every five seconds;
 *   the ROSTER is a cross-service GET — cached 30s inside portal-roster.ts,
 *   with its own last-good window.
 *
 * FAIL SOFT, PER INPUT. A dead Neon means everybody reads zero; a dead portal
 * means the race hosts alone and a dim note; a dead Redis means no tags. None
 * of the three can take the board down, because none of them is the board.
 */
import { businessDayYmdET } from "@/lib/race-business-day";
import { countBriefingsByStaff } from "../signage/briefing/assignments-db";
import type { BriefingRoom, BriefingRoomState } from "../signage/briefing/types";
import type { PitLanes } from "../signage/pit/pit-board";
import { buildCrewBoard, type BriefedCount, type CrewBoard } from "./crew-list";
import { currentStaffRacesFrom } from "./current-races";
import { fetchPortalTrackOpsNow, portalBusinessDayYmdET } from "./portal-roster";

/** Only FastTrax briefs anybody. */
const VENUE = "FT";

/**
 * How long a day's counts stand.
 *
 * Fifteen seconds against a five-second poll: a group briefed at 18:04:01
 * appears on the strip by 18:04:16 at the latest, which nobody can perceive
 * beside a number that moves once every ten minutes — and it takes a Postgres
 * round trip off the busiest poll in the building.
 */
const COUNTS_TTL_MS = 15_000;

let countsCache: {
  at: number;
  businessDay: string;
  value: { staff: BriefedCount[]; unattributed: number };
} | null = null;

async function briefingCounts(
  businessDay: string,
  now: number,
): Promise<{ staff: BriefedCount[]; unattributed: number }> {
  if (
    countsCache &&
    countsCache.businessDay === businessDay &&
    now - countsCache.at < COUNTS_TTL_MS
  ) {
    return countsCache.value;
  }
  try {
    const value = await countBriefingsByStaff(VENUE, businessDay);
    countsCache = { at: now, businessDay, value };
    return value;
  } catch {
    // Nothing is cached on a failure, so the next poll tries again rather than
    // showing a floor of zeroes for fifteen seconds.
    return { staff: [], unattributed: 0 };
  }
}

/**
 * The board, from lanes and rooms the caller already read.
 *
 * Both callers — `briefingBoardStatus` and `buildTvFeed` — hold the lanes and
 * the rooms before this is reached, so the only Redis this adds is the hosts'
 * single mget.
 */
export async function crewBoardFrom(input: {
  lanes: PitLanes | null;
  rooms: Partial<Record<BriefingRoom, BriefingRoomState | null>> | null;
  nowMs: number;
  /** OUR business day (2 AM rollover) — what the counts are keyed on. */
  businessDay?: string;
}): Promise<CrewBoard> {
  const businessDay = input.businessDay ?? businessDayYmdET();
  const [counts, currentRaces, onShiftTrackOps] = await Promise.all([
    briefingCounts(businessDay, input.nowMs),
    currentStaffRacesFrom({ lanes: input.lanes, rooms: input.rooms, nowMs: input.nowMs }).catch(
      () => [],
    ),
    // THE PORTAL'S DAY, NOT OURS. Theirs rolls at 5 AM and ours at 2 — asking
    // with our date between those hours would ask for a day it has no roster
    // for. No races run in that window, so the two only ever differ over an
    // empty one, but a wrong date is a wrong date.
    fetchPortalTrackOpsNow(portalBusinessDayYmdET()).catch(() => null),
  ]);

  return buildCrewBoard({
    briefedByStaff: counts.staff,
    unattributed: counts.unattributed,
    currentRaces,
    onShiftTrackOps,
  });
}
