import "server-only";

/**
 * What the pit board needs that a browser cannot fetch for itself: the staged
 * session, its roster with spots, and the per-racer joins (camera, birthday,
 * VIP). The lane's live state travels separately (readPitLanes on the pulse),
 * so a staff press reaches the wall in about two seconds while this heavier
 * build rides the 15-second feed.
 *
 * WHICH SESSION THE BOARD SHOWS: the group staff sent to HOLDING, and nothing
 * else (owner 2026-08-14). No holding group means the designed idle board. See
 * pitDisplaySession for why the earlier cascade is gone.
 *
 * Same fail-open posture as race-checkin.ts: any error returns a board with
 * less on it, never an error state on a wall.
 */
import redis from "@/lib/redis";
import { fetchIsBirthdayToday } from "@/lib/checkin-race-flags";
import { listAssignmentsForSession } from "@/lib/camera-assign";
import { vipComboPersonLegsOnDate } from "@/lib/bowling-db";
import { readRaceStartedMarker } from "../briefing/race-finish.server";
import { sessionBriefed } from "../briefing/state.server";
import { isLockedPlace, participantCheckedIn } from "../checkin-progress";
import { sessionRoster } from "../service/checkin-progress";
import type { TrackKey } from "../track";
import { readCueStamp } from "./audio.server";
import { readPitLane } from "./lane.server";
import type { BackToBackTarget } from "./back-to-back";
import { backToBackForRoster } from "./back-to-back.server";
import { scheduledStartOf } from "./day-schedule.server";
import {
  orderPitRoster,
  pitCardName,
  type PitBoardInfo,
  type PitParticipantRow,
  type PitRosterEntry,
} from "./pit-board";

/** A day-long per-person memo so the roster's birthday lookups cost one
 *  Pandora read per racer per day, not one per 15-second poll. */
async function birthdayFlag(personId: string, ymd: string): Promise<boolean> {
  const key = `pit:bday:${ymd}:${personId}`;
  try {
    const memo = await redis.get(key);
    if (memo === "1") return true;
    if (memo === "0") return false;
  } catch {
    /* fall through to the live read */
  }
  const value = await fetchIsBirthdayToday(personId, ymd).catch(() => false);
  try {
    await redis.set(key, value ? "1" : "0", "EX", 24 * 3600);
  } catch {
    /* a missed memo is just a re-read tomorrow */
  }
  return value;
}

/** Which session this track's board is showing — the pit board's one
 *  authority question, shared by the slow build below AND the fast-roster
 *  pulse (fast-roster.server.ts) so the two can never track different heats. */
export interface PitDisplaySession {
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  inHolding: boolean;
}

/**
 * HOLDING, OR NOTHING (owner 2026-08-14: "I'd like for the pit assignment TV to
 * only show the race once its set to holding").
 *
 * The board used to fill in early — the called heat appeared while the group was
 * still forming at the desk, then the briefed heat while they watched the film —
 * on the theory that staff liked watching the roster and the camera chips build.
 * In practice a screen above the pit seats that names a heat nobody has been
 * sent to is a screen that invites people to sit down early, and every bug this
 * function has had came from guessing which of several overlapping heats the
 * wall meant: Session 60 stealing the board while 59 walked to its karts, and
 * Session 56 sitting there "for seating" after its own race had finished.
 *
 * A staff press is unambiguous, so the board now waits for one. There is exactly
 * one candidate and no cascade to get wrong — which is why the assignments scan,
 * the called-record fallback and their marker reads are gone rather than merely
 * unreachable. It is also much cheaper: this runs on the 2-second pulse for
 * three tracks, and it is now one Redis read (two on a Mega day).
 *
 * The Mega fallback stays and mirrors race-checkin.ts: on a Mega day the staff
 * actions live under `mega`, and a blue- or red-scoped board must follow them or
 * sit blank on the busiest night of the week.
 */
export async function pitDisplaySession(track: TrackKey): Promise<PitDisplaySession | null> {
  /**
   * THE STAGED GROUP, SEATS OR KARTS. A group that has climbed into the karts is
   * still the group this wall is assigning — the board must not blank the
   * instant the pre-message lands, which is exactly what reading `holding` alone
   * would have done.
   *
   * Holding wins when both are filled, and that ordering is the point: once the
   * next group has been sent to the seats, THEY are who the wall is for. The
   * karts group is already where the board was telling them to go.
   */
  const staged = (lane: Awaited<ReturnType<typeof readPitLane>>) => lane.holding ?? lane.karts;

  let lane = await readPitLane(track);
  if (!staged(lane) && track !== "mega") {
    const megaLane = await readPitLane("mega");
    if (staged(megaLane)) lane = megaLane;
  }
  const group = staged(lane);
  if (!group) return null;

  return {
    sessionId: group.sessionId,
    heatNumber: group.heatNumber,
    raceType: group.raceType,
    // Always true now, and kept rather than removed: the rail state machine
    // takes it (pitRailState's `stagedInHolding`), and it is the one line to
    // change if a pre-holding preview is ever wanted back.
    //
    // True for the karts group too — `stagedInHolding` asks "has this group
    // reached the pit", and they demonstrably have. The alternative reads as
    // `info` ("still checking in, or watching the film"), which is the one
    // answer that is flatly wrong about somebody sitting in a kart.
    inHolding: true,
  };
}

export async function buildPitBoard(
  track: TrackKey,
  businessDate: string,
  nowMs: number,
): Promise<PitBoardInfo> {
  const empty: PitBoardInfo = { track, session: null, roster: null };

  const display = await pitDisplaySession(track);
  if (!display) return empty;
  const { sessionId, heatNumber, raceType, inHolding } = display;

  const [briefed, startedAtMs, preStamp, rows, cameras] = await Promise.all([
    sessionBriefed(sessionId).catch(() => null),
    readRaceStartedMarker(sessionId).catch(() => null),
    readCueStamp("pre", sessionId).catch(() => null),
    sessionRoster(sessionId, nowMs).catch(() => null),
    listAssignmentsForSession(sessionId).catch(() => []),
  ]);

  const session: NonNullable<PitBoardInfo["session"]> = {
    sessionId,
    heatNumber,
    raceType,
    briefedRoom: briefed?.room ?? null,
    briefedAtMs: briefed?.atMs ?? null,
    inHolding,
    startedAtMs,
    preRaceAtMs: preStamp?.atMs ?? null,
    preRaceDurationS: preStamp?.durationS ?? null,
  };
  if (!rows || rows.length === 0) return { track, session, roster: rows ? [] : null };

  // personIds stay STRINGS end to end (house rule). A row with no usable
  // personId still gets a card — a name and a spot are the board's whole job —
  // it just cannot carry a photo, a birthday or a VIP flag.
  const people = rows as PitParticipantRow[];
  const ordered = orderPitRoster(people);

  const cameraByPerson = new Map<string, string>();
  for (const a of cameras) {
    const pid = a.personId == null ? "" : String(a.personId);
    if (pid && a.systemNumber) cameraByPerson.set(pid, String(a.systemNumber));
  }

  const personIds = ordered
    .map(({ row }) => (row.personId == null ? "" : String(row.personId)))
    .filter((id) => /^\d+$/.test(id));

  /**
   * BACK-TO-BACK, batched like VIP rather than fanned out like birthday: the
   * question is answered for the whole grid by the same three reads it would
   * take for one racer (pit/back-to-back.server.ts). Needs the staged heat's own
   * `scheduledStart`, which the lane does not carry — heat NUMBERS must never be
   * used to order heats (tasks/lessons.md 2026-07-11).
   */
  const [vips, birthdays, backToBack] = await Promise.all([
    personIds.length > 0
      ? vipComboPersonLegsOnDate(personIds, businessDate).catch(() => new Map<string, unknown>())
      : Promise.resolve(new Map<string, unknown>()),
    Promise.all(
      ordered.map(async ({ row }) => {
        const pid = row.personId == null ? "" : String(row.personId);
        if (!/^\d+$/.test(pid)) return false;
        return birthdayFlag(pid, businessDate);
      }),
    ),
    personIds.length > 0
      ? scheduledStartOf(sessionId).then((start) =>
          backToBackForRoster(personIds, sessionId, start ?? "", nowMs),
        )
      : Promise.resolve(new Map<string, BackToBackTarget>()),
  ]);

  const roster: PitRosterEntry[] = ordered.map(({ row, spot }, i) => {
    const pid = row.personId == null ? "" : String(row.personId);
    // The ONE definition of "checked in" (a timestamp, not a flag) — the same
    // helper the counts and the ordering use, so a card and the rail can never
    // disagree about the same racer.
    const checkedIn = participantCheckedIn(row);
    const camera = cameraByPerson.get(pid) ?? null;
    const hasVideo = typeof row.viewpointCredit === "number" && row.viewpointCredit > 0;
    return {
      spot,
      name: pitCardName(row),
      personId: pid,
      participantId: row.participantId == null ? null : String(row.participantId),
      checkedIn,
      camera,
      cameraDue: hasVideo && camera == null,
      birthday: birthdays[i] === true,
      vip: vips.has(pid),
      // A locked place has no personId, so every id-keyed join above already
      // misses it — this is the one fact about the card that is positive.
      locked: isLockedPlace(row),
      backToBack: backToBack.get(pid) ?? null,
    };
  });

  return { track, session, roster };
}
