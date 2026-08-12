import "server-only";

/**
 * Resolve the welcome-back moment for one briefing room.
 *
 * Two reads, both already paid for elsewhere: the room's last briefed session
 * (Neon, `briefing_assignments` — the durable record written at send time), and
 * that session's row in the timing system's per-track sessions list — via the
 * SAME cron-warmed reader the VIP experience board uses
 * (reservations-admin/race-live-state.server, owner: "we already know when
 * sessions finish on the VIP experience board"). A session with `actualEnd`
 * stamped is finished as a matter of record, not inference.
 *
 * DELIBERATELY CARRIES NO NAMES. The board greets the group, says where kit goes
 * and where scores are posted, and restates the qualifying time. Who actually
 * levelled up is parked for later (owner 2026-08-11: "don't do any of the who
 * qualified on this screen yet").
 *
 * Fails to null, always — a briefing room with a broken upstream shows helmet
 * sizes, never an error.
 */
import { calendarYmdET } from "@/lib/race-business-day";
import { fetchTrackSessions } from "~/features/reservations-admin/race-live-state.server";
import type { TrackKey } from "~/features/reservations-admin/race-live-state";
import { listBriefingAssignments } from "./assignments-db";
import { welcomeBackWindowOpen } from "./welcome-back";
import type { BriefingRoom } from "./types";

export interface WelcomeBackInfo {
  heatNumber: number | null;
  raceType: string | null;
  track: "blue" | "red" | "mega";
  /** The timing system's own end stamp, ms — what opened the window. */
  endedAtMs: number;
}

export async function resolveWelcomeBack(
  venue: string,
  room: BriefingRoom,
  businessDay: string,
): Promise<WelcomeBackInfo | null> {
  // Newest-first; the first timeline row for this room is its latest group.
  const assignments = await listBriefingAssignments(venue, businessDay).catch(() => []);
  const last = assignments.find((a) => a.room === room && a.mode === "timeline") ?? null;
  if (!last) return null;

  const track: TrackKey =
    last.track === "blue" || last.track === "red" || last.track === "mega" ? last.track : "mega";

  // CALENDAR ET day, not the racing business day: the sessions cache is keyed the
  // way its warming cron keys it (todayETRange), and a post-midnight miss only
  // costs the reader its cache — it falls through to a live read on its own.
  const sessions = await fetchTrackSessions(track, calendarYmdET()).catch(() => null);
  if (!sessions) return null;

  // Compare as STRINGS — the sessions list carries string ids, and the house rule
  // forbids numeric round-trips on Pandora ids regardless.
  const session = sessions.find((s) => String(s.sessionId) === last.sessionId);
  const actualEndMs = session?.actualEnd ? Date.parse(session.actualEnd) : null;

  if (!welcomeBackWindowOpen(Number.isFinite(actualEndMs) ? actualEndMs : null)) {
    return null;
  }

  return {
    heatNumber: last.heatNumber,
    raceType: last.raceType,
    track,
    endedAtMs: actualEndMs as number,
  };
}
