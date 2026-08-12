/**
 * "6 of 14 checked in" — the desk's progress through the heats it currently has
 * open, for the boards that are not the desk.
 *
 * PURE. Selection, counting and ordering only; the Redis/Pandora reads live in
 * ./service/checkin-progress.ts. Split so the rule that decides WHICH heats
 * count as "checking in" — and the one that decides whether a racer is in — can
 * be unit-tested without a network.
 *
 * SAME DEFINITION AS THE CHECK-IN BOARD, deliberately. The board's strip
 * (/api/admin/checkin?action=session-stats) is: every track whose called heat is
 * still displayable, counted against the session's roster. If the two ever
 * disagreed, a staff member looking up at a wall and a staff member looking down
 * at the station would be reading different numbers about the same group, which
 * is worse than the wall showing nothing.
 *
 * FASTTRAX TRACKS ONLY. The check-in station also carries HP Arena sessions, but
 * those belong to another building; a Fort Myers briefing-room wall counting
 * laser tag would be noise on a screen a marshal reads at a glance.
 */
import { raceStillDisplayable } from "~/features/racing/current-race-freshness";
import { checkinAlert } from "./briefing/desk-alerts";
import type { TrackKey } from "./track";

/** One heat the desk currently has open, with its progress. */
export interface CheckinProgressSession {
  track: TrackKey;
  /** Pandora's heat number, or null when the entry carries none. */
  heatNumber: number | null;
  /** "Junior Starter", "Pro", … — empty when the entry carries none. */
  raceType: string;
  /**
   * STRING, end to end. Pandora session ids are small today, but the house rule
   * is that no id from BMI or Pandora ever passes through `Number()` — the one
   * that grows past 2^53 is the one nobody remembers to fix.
   */
  sessionId: string;
  checkedIn: number;
  total: number;
  /**
   * Staff have already sent this heat to a briefing room.
   *
   * Which ENDS the rail's job: check-in is over, the group is walking to the
   * room, and a board still counting them is describing the past (owner
   * 2026-08-12: "this section can be cleared once they're sent to the room").
   * The same marker the track boards clear on — one send, every board reacts.
   */
  briefed: boolean;
  /**
   * When the heat was CALLED, which is when the group started waiting.
   *
   * The anchor every check-in clock in the estate counts from — the track
   * boards' countdown, the desk board's "checking in for X", and now the rail's
   * count-up. Null when the stored entry carried no usable timestamp; the rail
   * then shows progress with no clock rather than a made-up one.
   */
  calledAtMs: number | null;
}

/** The stored races-current entry this module reads — anything else is ignored. */
export interface CalledRaceRecord {
  sessionId?: number | string | null;
  raceType?: string | null;
  heatNumber?: number | null;
  calledAt?: string | null;
}

/** The one field of a roster row that matters here. */
export interface CheckinRosterRow {
  checkedIn?: string | boolean | null;
}

/**
 * Is this racer checked in?
 *
 * `checkedIn` IS A TIMESTAMP, NOT A FLAG. Pandora sends the moment BMI recorded
 * the check-in (`Participant.checkedIn: string | null`), so a reader comparing it
 * to `true` counts zero forever — which is exactly what the track board's
 * "N of M" did, silently, for every heat. Compared the way the check-in station
 * itself compares it (`!!p.checkedIn`), with an empty string treated as absent
 * so a blank field can never read as present.
 */
export function participantCheckedIn(row: CheckinRosterRow): boolean {
  const v = row.checkedIn;
  if (v === true) return true;
  if (typeof v !== "string") return false;
  return v.trim().length > 0;
}

/** Progress through a roster. Total is every row we were given. */
export function countCheckedIn(rows: CheckinRosterRow[]): { checkedIn: number; total: number } {
  return { checkedIn: rows.filter(participantCheckedIn).length, total: rows.length };
}

/**
 * Which tracks have a heat checking in right now.
 *
 * Age-gated by the SAME pure rule the races-current proxy applies before it
 * serves a track (`raceStillDisplayable`), because that gate is what the word
 * "currently" means here: Pandora drops its own entry ~20 minutes after a call,
 * and the Redis copy that keeps a board populated between heats has to be
 * stopped from carrying last night's finale into the morning.
 *
 * An entry with no usable session id is dropped — there is nothing to count.
 */
export function checkingInTracks(
  byTrack: Partial<Record<TrackKey, CalledRaceRecord | null>>,
  nowMs: number,
): Array<{
  track: TrackKey;
  sessionId: string;
  heatNumber: number | null;
  raceType: string;
  calledAtMs: number | null;
}> {
  const out: Array<{
    track: TrackKey;
    sessionId: string;
    heatNumber: number | null;
    raceType: string;
    calledAtMs: number | null;
  }> = [];
  for (const track of ["blue", "red", "mega"] as const) {
    const record = byTrack[track];
    if (!record) continue;
    if (!raceStillDisplayable(record, nowMs)) continue;
    const sessionId = record.sessionId == null ? "" : String(record.sessionId).trim();
    if (!sessionId) continue;
    const calledAtMs = record.calledAt ? Date.parse(record.calledAt) : NaN;
    out.push({
      track,
      sessionId,
      heatNumber: typeof record.heatNumber === "number" ? record.heatNumber : null,
      raceType: (record.raceType ?? "").trim(),
      calledAtMs: Number.isFinite(calledAtMs) ? calledAtMs : null,
    });
  }
  return out;
}

/**
 * THIS ROOM'S HEAT, and only this room's (owner 2026-08-12: "only show checking
 * in status for that room, don't show both tracks").
 *
 * A marshal in the Blue briefing room is asking one question — "how many of MINE
 * are still at the desk". The Red heat's progress is not an answer to it, it is
 * a second number to read past, and on a wall glanced at from across a room the
 * cost of the wrong number being the bigger one is real.
 *
 * MEGA FALLBACK, the same rule the track boards use (see ./service/race-checkin):
 * a board scoped to blue or red finds no heat of its own on a Mega day, because
 * the only session called is the Mega one — and that IS what is checking in for
 * this room. Exact track first, so an ordinary day never reads a stale mega row.
 *
 * A heat already SENT to a room is not checking in any more, so it drops out
 * here and the rail clears itself — the board goes quiet until the next heat is
 * called, which is the honest state of the room.
 *
 * Null when nothing of this room's is checking in, or the board has no track.
 */
export function roomCheckinProgress(
  sessions: CheckinProgressSession[],
  ownTrack: TrackKey | null,
): CheckinProgressSession | null {
  if (!ownTrack) return null;
  const open = sessions.filter((s) => !s.briefed);
  const byHeat = (a: CheckinProgressSession, b: CheckinProgressSession) =>
    (a.heatNumber ?? Number.MAX_SAFE_INTEGER) - (b.heatNumber ?? Number.MAX_SAFE_INTEGER);
  const mine = open.filter((s) => s.track === ownTrack).sort(byHeat);
  if (mine.length > 0) return mine[0];
  const mega = open.filter((s) => s.track === "mega").sort(byHeat);
  return mega[0] ?? null;
}

/**
 * Is this heat ready to be sent — everyone on the roster is in?
 *
 * The rail flashes on this (owner 2026-08-12: "if we haven't sent that session
 * to a room yet, flash green when they're ready"). Guarded on a non-zero total
 * so an empty roster can never read as a full one.
 */
export function readyToSend(session: CheckinProgressSession): boolean {
  return session.total > 0 && session.checkedIn >= session.total;
}

/** How long this heat has been at the desk. Null with no call timestamp. */
export function waitingMs(session: CheckinProgressSession, nowMs: number): number | null {
  if (session.calledAtMs == null) return null;
  return Math.max(0, nowMs - session.calledAtMs);
}

/**
 * What the rail is SAYING right now.
 *
 *   counting  everyone is arriving, nothing to do
 *   closing   the check-in window is nearly up (the desk board's `warn`)
 *   ready     all in, nobody has sent them — flash green, it is a thing to DO
 *   overdue   past the window — they have been at the desk too long (owner
 *             2026-08-12: "so we know when they've been waiting at check in too
 *             long to be called to room")
 *
 * THE THRESHOLDS ARE THE DESK BOARD'S, imported not copied: `checkinAlert` in
 * ./briefing/desk-alerts, counting from the call, against the SAME per-screen
 * `checkinWindowMins` the track TVs count down for guests. A wall that escalated
 * on its own numbers would eventually contradict the station it is reporting on.
 *
 * OVERDUE OUTRANKS READY, because a group that is all present and STILL has not
 * been sent is the exact failure the owner asked to see; the eyebrow then says
 * to send them rather than just naming the problem.
 */
export type CheckinRailState = "counting" | "closing" | "ready" | "overdue";

export function checkinRailState(
  session: CheckinProgressSession,
  nowMs: number,
  windowMins: number,
): CheckinRailState {
  const since = waitingMs(session, nowMs);
  const alert = since == null ? "none" : checkinAlert(since, windowMins);
  if (alert === "late") return "overdue";
  if (readyToSend(session)) return "ready";
  if (alert === "warn") return "closing";
  return "counting";
}

/**
 * How a heat is NAMED on these boards: "Session 31 · Pro".
 *
 * ONE naming, every strip on the wall (owner 2026-08-12: "need to be consistent
 * on naming"). The camera caption already said "Session 31 · Pro" while the
 * check-in rail beside it said "Red #31 · Pro" — two names for one heat, six
 * inches apart. This is that name, and both callers use it.
 *
 * The track is NOT in it: the board belongs to one room, so naming its track on
 * every line says nothing. Mega is the exception and keeps its word, because a
 * Mega heat in the Blue room genuinely is a different thing.
 */
export function sessionLabel(
  heatNumber: number | null,
  raceType: string,
  track?: TrackKey,
): string {
  const prefix = track === "mega" ? "Mega session" : "Session";
  const name = heatNumber != null ? `${prefix} ${heatNumber}` : prefix;
  return raceType ? `${name} · ${raceType}` : name;
}
