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
): Array<{ track: TrackKey; sessionId: string; heatNumber: number | null; raceType: string }> {
  const out: Array<{
    track: TrackKey;
    sessionId: string;
    heatNumber: number | null;
    raceType: string;
  }> = [];
  for (const track of ["blue", "red", "mega"] as const) {
    const record = byTrack[track];
    if (!record) continue;
    if (!raceStillDisplayable(record, nowMs)) continue;
    const sessionId = record.sessionId == null ? "" : String(record.sessionId).trim();
    if (!sessionId) continue;
    out.push({
      track,
      sessionId,
      heatNumber: typeof record.heatNumber === "number" ? record.heatNumber : null,
      raceType: (record.raceType ?? "").trim(),
    });
  }
  return out;
}

/**
 * Reading order for a board that belongs to a track: ITS OWN HEAT FIRST.
 *
 * A marshal in the Blue briefing room is asking one question — "how many of mine
 * are still at the desk" — and should not have to scan a list for their own row.
 * Everything else follows by heat number, so the rest reads in the order the
 * night runs. `ownTrack` null (a camera with no track) leaves plain heat order.
 */
export function orderCheckinProgress(
  sessions: CheckinProgressSession[],
  ownTrack: TrackKey | null,
): CheckinProgressSession[] {
  return [...sessions].sort((a, b) => {
    if (ownTrack) {
      const aOwn = a.track === ownTrack ? 0 : 1;
      const bOwn = b.track === ownTrack ? 0 : 1;
      if (aOwn !== bOwn) return aOwn - bOwn;
    }
    return (a.heatNumber ?? Number.MAX_SAFE_INTEGER) - (b.heatNumber ?? Number.MAX_SAFE_INTEGER);
  });
}
