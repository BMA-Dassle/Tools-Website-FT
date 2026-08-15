import "server-only";

/**
 * The I/O around back-to-back.ts — read the day's schedule, read the handful of
 * rosters that matter, hand the pure part the facts.
 *
 * ONE UPSTREAM COST FOR THE WHOLE GRID, not one per racer. This follows the VIP
 * shape in pit/service.ts (`vipComboPersonLegsOnDate`, one query for every
 * personId) rather than the birthday shape (one cached fetch per person): the
 * question "is this racer on one of three other rosters" is answered for forty
 * racers by the same three reads it takes to answer for one.
 *
 * The schedule itself comes from `day-schedule.server.ts`, shared with the pit
 * lane so the two cannot drift on what "later" means.
 *
 * COST: three session lists (already cached and usually warm) plus at most three
 * rosters through `sessionRoster`, which is memoised for 12 seconds and is the
 * same read the boards are already making. Runs on the 15s feed build only —
 * nothing here touches the 2s pulse.
 */
import { sessionRoster } from "../service/checkin-progress";
import { daySessions } from "./day-schedule.server";
import {
  backToBackMap,
  groupJoining,
  nextTwoAfter,
  racesRunningNow,
  type B2BRoster,
  type B2BSession,
  type BackToBackTarget,
  type JoiningGroup,
} from "./back-to-back";
import type { PitParticipantRow } from "./pit-board";

/** One session's personIds, as strings. Null roster reads as nobody, never as
 *  an error — a missing roster costs a badge, not a board. */
async function membersOf(sessionId: string, nowMs: number): Promise<string[]> {
  const rows = (await sessionRoster(sessionId, nowMs).catch(() => null)) as
    | PitParticipantRow[]
    | null;
  if (!rows) return [];
  return rows
    .map((r) => (r.personId == null ? "" : String(r.personId)))
    .filter((id) => /^\d+$/.test(id));
}

async function rostersFor(sessions: B2BSession[], nowMs: number): Promise<B2BRoster[]> {
  return Promise.all(
    sessions.map(async (session) => ({
      session,
      members: await membersOf(session.sessionId, nowMs),
    })),
  );
}

/**
 * Who on this grid is back-to-back, and where they are going.
 *
 * Fails to an EMPTY MAP, never throws: every consumer of this is a badge or a
 * panel, and a board that cannot answer "who races again" must still show the
 * grid. An empty map is indistinguishable from "nobody is back-to-back", which
 * is the honest degraded state.
 */
export async function backToBackForRoster(
  personIds: string[],
  stagedSessionId: string,
  stagedScheduledStart: string,
  nowMs: number,
): Promise<Map<string, BackToBackTarget>> {
  const empty = new Map<string, BackToBackTarget>();
  if (personIds.length === 0 || !stagedSessionId) return empty;
  try {
    const sessions = await daySessions();
    if (sessions.length === 0) return empty;

    const arrivingSessions = racesRunningNow(sessions, stagedSessionId);
    const againSessions = stagedScheduledStart
      ? nextTwoAfter(sessions, stagedSessionId, stagedScheduledStart)
      : [];
    if (arrivingSessions.length === 0 && againSessions.length === 0) return empty;

    const [arriving, again] = await Promise.all([
      rostersFor(arrivingSessions, nowMs),
      rostersFor(againSessions, nowMs),
    ]);
    return backToBackMap({ personIds, arriving, again });
  } catch {
    return empty;
  }
}

/**
 * The group that just finished, grouped by the heat each of them is joining
 * next — what the welcome-back wall and the check-in camera board both render.
 *
 * NAMES COME FROM THE ROSTER, NEVER FROM THE TIMING SOCKET. The welcome-back
 * board's qualifying lists are socket standings (transponder names, sometimes a
 * kart alias, sometimes a nickname); matching those back to BMI people is
 * exactly the fuzzy join this codebase has been bitten by before. The roster is
 * already keyed by personId, which is the only key both sides agree on.
 *
 * `arriving` is not asked here and could not be true anyway — this group is
 * standing in a briefing room, not out on track.
 *
 * Fails to an EMPTY ARRAY: a wall that cannot answer "who races again" shows
 * the qualifying split alone, which is what it showed yesterday.
 */
export async function racingAgainAfter(
  finishedSessionId: string,
  nowMs: number,
): Promise<JoiningGroup[]> {
  if (!finishedSessionId) return [];
  try {
    const sessions = await daySessions();
    const anchor = sessions.find((s) => s.sessionId === finishedSessionId);
    if (!anchor) return [];

    const againSessions = nextTwoAfter(sessions, finishedSessionId, anchor.scheduledStart);
    if (againSessions.length === 0) return [];

    const rows = (await sessionRoster(finishedSessionId, nowMs).catch(() => null)) as
      | PitParticipantRow[]
      | null;
    if (!rows || rows.length === 0) return [];

    const nameByPerson = new Map<string, string>();
    for (const r of rows) {
      const pid = r.personId == null ? "" : String(r.personId);
      if (!/^\d+$/.test(pid)) continue;
      const name = [r.firstName ?? "", r.lastName ?? ""].join(" ").trim();
      if (name) nameByPerson.set(pid, name);
    }
    if (nameByPerson.size === 0) return [];

    const again = await rostersFor(againSessions, nowMs);
    const targets = backToBackMap({ personIds: [...nameByPerson.keys()], arriving: [], again });

    // Roster order, so the rows read the same way twice running.
    const entries: Array<{ name: string; target: BackToBackTarget }> = [];
    for (const [pid, name] of nameByPerson) {
      const target = targets.get(pid);
      if (target) entries.push({ name, target });
    }
    return groupJoining(entries);
  } catch {
    return [];
  }
}
