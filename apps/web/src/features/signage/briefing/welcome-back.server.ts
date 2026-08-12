import "server-only";

/**
 * Resolve the welcome-back moment for one briefing room.
 *
 * Two reads, both already paid for elsewhere: the room's last briefed session
 * (Neon, `briefing_assignments` — the durable record written at send time), and
 * that session's row in the timing system's per-track sessions list — via the
 * SAME shared reader the VIP experience board uses
 * (reservations-admin/race-live-state.server, owner: "we already know when
 * sessions finish on the VIP experience board"; since 2026-08-11 that reader
 * self-refreshes from Pandora on a 15s fleet-wide claim, so an end reaches
 * these boards in ~20-45s, not the old 2-3 min). A session with `actualEnd`
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
import { announceReturnOnce } from "./return-announce.server";
import type { BriefingRoom } from "./types";

export interface WelcomeBackInfo {
  heatNumber: number | null;
  raceType: string | null;
  track: "blue" | "red" | "mega";
  /** The timing system's own end stamp, ms — what opened the window. */
  endedAtMs: number;
}

/** Only ends this fresh get a radio call. Bounds what an announcement can be
 *  about to "the group walking back in right now" — a deploy, an outage or a
 *  long-open board can never speak about a race from an hour ago. */
const ANNOUNCE_FRESH_MS = 10 * 60_000;

/** How many of a room's recent groups the announcer watches. More than one,
 *  because that is the bug this fixes: on a busy night the NEXT group is sent
 *  before the previous group's actualEnd becomes visible, so an announcer that
 *  only watched the latest assignment missed almost every real return — heat
 *  62's end landed after heat 64 had already replaced it as red's latest
 *  (probe, 2026-08-11, under the old 2-min cron warm). The sessions reader now
 *  self-refreshes on a 15s claim, which shrinks that blind spot but cannot
 *  close it — back-to-back sends can still overtake an end inside one window. */
const ANNOUNCE_LOOKBACK = 4;

export async function resolveWelcomeBack(
  venue: string,
  room: BriefingRoom,
  businessDay: string,
): Promise<WelcomeBackInfo | null> {
  // Newest-first; the first timeline row for this room is its latest group.
  const assignments = await listBriefingAssignments(venue, businessDay).catch(() => []);
  const roomTimeline = assignments.filter((a) => a.room === room && a.mode === "timeline");
  const last = roomTimeline[0] ?? null;
  if (!last) return null;

  // THE ANNOUNCER WATCHES THE LAST FEW GROUPS, not just the latest — each one
  // gets its radio call once, when its own end stamps, even if a newer group
  // has since taken the room. The BOARD below still tracks only the latest;
  // announcing and displaying are different questions with different subjects.
  for (const a of roomTimeline.slice(0, ANNOUNCE_LOOKBACK)) {
    const aTrack: TrackKey =
      a.track === "blue" || a.track === "red" || a.track === "mega" ? a.track : "mega";
    // fetchTrackSessions memory-caches per track+day for 15s, so this loop costs
    // one upstream read per track, not one per assignment.
    const list = await fetchTrackSessions(aTrack, calendarYmdET()).catch(() => null);
    const row = list?.find((s) => String(s.sessionId) === a.sessionId);
    const endMs = row?.actualEnd ? Date.parse(row.actualEnd) : NaN;
    if (!Number.isFinite(endMs)) continue;
    const sinceEnd = Date.now() - endMs;
    if (sinceEnd < -60_000 || sinceEnd > ANNOUNCE_FRESH_MS) continue;
    // Awaited (never throws, 5s timeout): a floating promise on a serverless
    // path can be frozen mid-flight after the response goes out. The cost lands
    // on the one poll per session that wins the claim.
    await announceReturnOnce({ room, sessionId: a.sessionId, heatNumber: a.heatNumber });
  }

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
