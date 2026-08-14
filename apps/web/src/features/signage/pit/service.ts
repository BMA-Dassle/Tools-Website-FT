import "server-only";

/**
 * What the pit board needs that a browser cannot fetch for itself: the staged
 * session, its roster with spots, and the per-racer joins (camera, birthday,
 * VIP). The lane's live state travels separately (readPitLanes on the pulse),
 * so a staff press reaches the wall in about two seconds while this heavier
 * build rides the 15-second feed.
 *
 * WHICH SESSION THE BOARD SHOWS, in order of authority:
 *
 *   1. The group staff sent to HOLDING that has not green-flagged — they are
 *      standing at the seats, so the board is unambiguously theirs.
 *   2. Otherwise the session currently called on this track (the same record
 *      the check-in board reads) — the board fills in as the group forms at
 *      the desk, which is deliberate: staff watch the roster and the camera
 *      chips build before anyone reaches the pit.
 *
 * Same fail-open posture as race-checkin.ts: any error returns a board with
 * less on it, never an error state on a wall.
 */
import redis from "@/lib/redis";
import { fetchIsBirthdayToday } from "@/lib/checkin-race-flags";
import { listAssignmentsForSession } from "@/lib/camera-assign";
import { vipComboPersonLegsOnDate } from "@/lib/bowling-db";
import { businessDayYmdET } from "@/lib/race-business-day";
import { listBriefingAssignments, type BriefingAssignment } from "../briefing/assignments-db";
import { readRaceFinishedMarker, readRaceStartedMarker } from "../briefing/race-finish.server";
import { sessionBriefed } from "../briefing/state.server";
import { participantCheckedIn } from "../checkin-progress";
import { currentSession } from "../service/race-checkin";
import { sessionRoster } from "../service/checkin-progress";
import type { TrackKey } from "../track";
import { readPitLane } from "./lane.server";
import {
  orderPitRoster,
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

/** Today's briefing sends, memoised for the pulse: pitDisplaySession runs on
 *  the 2-second lane every poll for three tracks, and the desk's own board
 *  already reads this table every 5 seconds — one more reader at the same
 *  cadence is fine, one per pulse per track is not. */
const ASSIGNMENTS_TTL_MS = 5_000;
let assignmentsMemo: { at: number; value: BriefingAssignment[] } | null = null;

async function todaysAssignments(nowMs: number): Promise<BriefingAssignment[]> {
  if (assignmentsMemo && nowMs - assignmentsMemo.at < ASSIGNMENTS_TTL_MS) {
    return assignmentsMemo.value;
  }
  const value = await listBriefingAssignments("FT", businessDayYmdET()).catch(() => []);
  assignmentsMemo = { at: nowMs, value };
  return value;
}

export async function pitDisplaySession(track: TrackKey): Promise<PitDisplaySession | null> {
  // The holding group owns the board. Mega fallback mirrors race-checkin.ts:
  // on a Mega day the staff actions and the called record live under `mega`,
  // and a blue- or red-scoped board must follow them or sit blank on the
  // busiest night of the week.
  let lane = await readPitLane(track);
  if (!lane.holding && track !== "mega") {
    const megaLane = await readPitLane("mega");
    if (megaLane.holding) lane = megaLane;
  }

  if (lane.holding) {
    return {
      sessionId: lane.holding.sessionId,
      heatNumber: lane.holding.heatNumber,
      raceType: lane.holding.raceType,
      inHolding: true,
    };
  }

  // BRIEFED-BUT-NOT-RACED OUTRANKS THE CALLED RECORD. The pipeline overlaps
  // by design — the desk calls the NEXT heat while this one is still in a
  // room — and `pandora:last-race` only remembers the newest call, which is
  // how Session 60 stole the board while 59 was still walking to its karts
  // (live 2026-08-13). The newest send for this track that has neither
  // started nor finished is the group about to be seated, whatever the desk
  // has called since. An undone send revokes the claim via the briefed
  // marker, same as the desk's own room badge.
  const tracksOk = track === "mega" ? ["mega"] : [track, "mega"];
  for (const a of await todaysAssignments(Date.now())) {
    if (a.mode !== "timeline" || !tracksOk.includes(a.track)) continue;
    const [started, finished, briefed] = await Promise.all([
      readRaceStartedMarker(a.sessionId).catch(() => null),
      readRaceFinishedMarker(a.sessionId).catch(() => null),
      sessionBriefed(a.sessionId).catch(() => null),
    ]);
    // Newest send for this track has already raced (or was undone) — nothing
    // is pending between the rooms and the grid; fall through to the call.
    if (started != null || finished != null || !briefed) break;
    return {
      sessionId: a.sessionId,
      heatNumber: a.heatNumber,
      raceType: a.raceType,
      inHolding: false,
    };
  }

  // A FINISHED SESSION IS NOT SEATABLE. The called record (`pandora:last-race`)
  // only rolls when the NEXT session is called, so between the flag and the
  // next call it still names a heat that has already raced — which is exactly
  // how Session 56 sat on the board "for seating" after its race ended (live
  // 2026-08-13). A candidate with a finish marker is skipped; no unfinished
  // candidate means the designed idle board, which is the honest answer.
  for (const candidate of [await currentSession(track), await currentSession("mega")]) {
    if (typeof candidate?.sessionId !== "number" && typeof candidate?.sessionId !== "string") {
      continue;
    }
    const sessionId = String(candidate.sessionId);
    const finished = await readRaceFinishedMarker(sessionId).catch(() => null);
    if (finished) continue;
    return {
      sessionId,
      heatNumber: typeof candidate.heatNumber === "number" ? candidate.heatNumber : null,
      raceType: candidate.raceType?.trim() || null,
      inHolding: false,
    };
  }
  return null;
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

  const [briefed, startedAtMs, rows, cameras] = await Promise.all([
    sessionBriefed(sessionId).catch(() => null),
    readRaceStartedMarker(sessionId).catch(() => null),
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

  const [vips, birthdays] = await Promise.all([
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
  ]);

  const roster: PitRosterEntry[] = ordered.map(({ row, spot }, i) => {
    const pid = row.personId == null ? "" : String(row.personId);
    // The ONE definition of "checked in" (a timestamp, not a flag) — the same
    // helper the counts and the ordering use, so a card and the rail can never
    // disagree about the same racer.
    const checkedIn = participantCheckedIn(row);
    const camera = cameraByPerson.get(pid) ?? null;
    const hasVideo = typeof row.viewpointCredit === "number" && row.viewpointCredit > 0;
    const name = [row.firstName ?? "", row.lastName ?? ""].join(" ").trim() || "Racer";
    return {
      spot,
      name,
      personId: pid,
      participantId: row.participantId == null ? null : String(row.participantId),
      checkedIn,
      camera,
      cameraDue: hasVideo && camera == null,
      birthday: birthdays[i] === true,
      vip: vips.has(pid),
    };
  });

  return { track, session, roster };
}
