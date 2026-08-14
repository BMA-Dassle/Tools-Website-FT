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
import { readRaceStartedMarker } from "../briefing/race-finish.server";
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

export async function buildPitBoard(
  track: TrackKey,
  businessDate: string,
  nowMs: number,
): Promise<PitBoardInfo> {
  const empty: PitBoardInfo = { track, session: null, roster: null };

  // The holding group owns the board. Mega fallback mirrors race-checkin.ts:
  // on a Mega day the staff actions and the called record live under `mega`,
  // and a blue- or red-scoped board must follow them or sit blank on the
  // busiest night of the week.
  let lane = await readPitLane(track);
  if (!lane.holding && track !== "mega") {
    const megaLane = await readPitLane("mega");
    if (megaLane.holding) lane = megaLane;
  }

  let sessionId: string | null = null;
  let heatNumber: number | null = null;
  let raceType: string | null = null;
  let inHolding = false;

  if (lane.holding) {
    sessionId = lane.holding.sessionId;
    heatNumber = lane.holding.heatNumber;
    raceType = lane.holding.raceType;
    inHolding = true;
  } else {
    const race = (await currentSession(track)) ?? (await currentSession("mega"));
    if (typeof race?.sessionId === "number" || typeof race?.sessionId === "string") {
      sessionId = String(race.sessionId);
      heatNumber = typeof race.heatNumber === "number" ? race.heatNumber : null;
      raceType = race.raceType?.trim() || null;
    }
  }
  if (!sessionId) return empty;

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
