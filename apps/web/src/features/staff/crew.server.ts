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
 *   the COUNTS are a Neon `GROUP BY` — cached 15s and served stale while they
 *   refresh, because a briefing lands about every ten minutes and the boards
 *   now poll every two seconds;
 *   the ROSTER is a cross-service GET — cached 30s inside portal-roster.ts,
 *   served stale the same way, with its own last-good window.
 *
 * NOTHING HERE WAITS ON A NETWORK CALL that is not Redis, except the very first
 * read of an isolate. That is the property that lets the crew board ride the
 * 2-second TV pulse and the desk board's fast lane (2026-09-12).
 *
 * FAIL SOFT, PER INPUT. A dead Neon means everybody reads zero; a dead portal
 * means the race hosts alone and a dim note; a dead Redis means no tags. None
 * of the three can take the board down, because none of them is the board.
 */
import { businessDayYmdET } from "@/lib/race-business-day";
import { createSwrCache } from "~/lib/helpers/swr-cache";
import { afterResponse } from "../signage/after-response.server";
import { countBriefingsByStaff } from "../signage/briefing/assignments-db";
import { readBriefingRooms } from "../signage/briefing/state.server";
import type { BriefingRoom, BriefingRoomState } from "../signage/briefing/types";
import { readPitLanes } from "../signage/pit/lane.server";
import type { PitLanes } from "../signage/pit/pit-board";
import { buildCrewBoard, type BriefedCount, type CrewBoard } from "./crew-list";
import { currentStaffRacesFrom } from "./current-races";
import { fetchPortalTrackOpsNow, portalBusinessDayYmdET } from "./portal-roster";

/** Only FastTrax briefs anybody. */
const VENUE = "FT";

/**
 * How long a day's counts stand.
 *
 * Fifteen seconds against a two-second pulse: a group briefed at 18:04:01
 * appears on the strip by 18:04:16 at the latest, which nobody can perceive
 * beside a number that moves once every ten minutes — and it takes a Postgres
 * round trip off the busiest poll in the building.
 *
 * SERVED STALE WHILE IT REFRESHES (2026-09-12), like the roster: the poll that
 * lands on an expired cache hands back the last count and the GROUP BY runs
 * behind the response, so the Neon round trip never sits in front of a pulse.
 * Keyed by business day, so the 2 AM rollover starts a cold read rather than
 * serving yesterday's totals against today's floor.
 */
const COUNTS_TTL_MS = 15_000;

const countsCache = createSwrCache<{ staff: BriefedCount[]; unattributed: number }>({
  ttlMs: COUNTS_TTL_MS,
  // Counts only ever grow through a night and a stale one is one send behind;
  // there is no age at which yesterday's-poll number is worse than a zero, so
  // a stale value stands for as long as Neon is unreachable.
  maxStaleMs: null,
  retryAfterMs: COUNTS_TTL_MS,
  load: (businessDay) => countBriefingsByStaff(VENUE, businessDay),
  schedule: afterResponse,
});

async function briefingCounts(
  businessDay: string,
  now: number,
): Promise<{ staff: BriefedCount[]; unattributed: number }> {
  try {
    return await countsCache.read(businessDay, now);
  } catch {
    // A cold read that failed: everybody reads zero for this poll, and the
    // failure is remembered for one TTL so the next polls do not each pay it.
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

/**
 * The board for a caller holding nothing — the TV feed.
 *
 * Two MGETs of its own rather than threading the feed's `pitLanes` through:
 * only pit-board screens read the lanes at all (a briefing TV and a camera
 * board do not), so the alternative was reading them conditionally for one
 * section and sequencing the rest of a flat `Promise.all` behind it. The lanes
 * a wall RENDERS come off the 2-second pulse in any case, so threading the 15s
 * copy in would have bought consistency it cannot actually have.
 */
export async function crewBoard(nowMs: number = Date.now()): Promise<CrewBoard> {
  const [lanes, rooms] = await Promise.all([
    readPitLanes().catch(() => null),
    readBriefingRooms(VENUE).catch(() => null),
  ]);
  return crewBoardFrom({ lanes, rooms, nowMs });
}
