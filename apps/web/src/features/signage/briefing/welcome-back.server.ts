import "server-only";

/**
 * Resolve the welcome-back moment for one briefing room.
 *
 * Two reads, both already paid for elsewhere: the room's last briefed session
 * (Neon, `briefing_assignments` — the durable record written at send time), and
 * that session's row in the timing system's per-track sessions list — via the
 * SAME shared reader the VIP experience board uses
 * (reservations-admin/race-live-state.server, owner: "we already know when
 * sessions finish on the VIP experience board") — called with `fresh: true`,
 * which reads Pandora live on every poll: the owner's budget is "15 seconds,
 * no more" (2026-08-11), the TV's 15s poll spends all of it, so the data at
 * poll time must be current. A session with `actualEnd` stamped is finished
 * as a matter of record, not inference.
 *
 * SINCE 2026-08-12 THE END SIGNAL HAS A FAST PATH: the venue timing server's
 * own RaceFinish record, delivered by kart-timing-bridge to our webhook within
 * seconds of the flag and left as a Redis marker (race-finish.server.ts).
 * When the marker exists this resolver does not touch Pandora at all; the
 * fresh Pandora read below is the unchanged fallback for a down or late
 * bridge pipe — a dead bridge costs speed, never correctness.
 *
 * NOW CARRIES NAMES (owner 2026-08-11, superseding the same day's "park who
 * qualified"): the first poll that finds the window open captures the finished
 * heat's standings off the live timing socket — names and best laps exactly as
 * /leaderboards shows them, no BMI person matching — records them, and every
 * poll after serves the split: who beat the qualifying time, who didn't.
 *
 * Fails to null, always — a briefing room with a broken upstream shows helmet
 * sizes, never an error; a failed capture shows the board without names.
 */
import { calendarYmdET } from "@/lib/race-business-day";
import { fetchTrackSessions } from "~/features/reservations-admin/race-live-state.server";
import type { TrackKey } from "~/features/reservations-admin/race-live-state";
import { nextLevelTarget } from "~/features/racing/qualify";
import { listBriefingAssignments } from "./assignments-db";
import { welcomeBackWindowOpen } from "./welcome-back";
import { announceReturnOnce } from "./return-announce.server";
import { loadOrCaptureResults } from "./race-results.server";
import { readRaceFinishedMarker } from "./race-finish.server";
import { splitByTarget } from "./results-frame";
import type { BriefingRoom } from "./types";

/** The name board: who levelled up, who didn't, laps as recorded at the end of
 *  the race. `levelledUp` stays empty when there is no next level (Pro, Mega) —
 *  the scene shows plain final standings instead of a split. */
export interface WelcomeBackResults {
  levelledUp: Array<{ name: string; bestMs: number }>;
  keepPushing: Array<{ name: string; bestMs: number | null }>;
}

export interface WelcomeBackInfo {
  heatNumber: number | null;
  raceType: string | null;
  track: "blue" | "red" | "mega";
  /** The timing system's own end stamp, ms — what opened the window. */
  endedAtMs: number;
  /** Null when capture never landed — the board renders name-less, as before. */
  results: WelcomeBackResults | null;
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
 *  (probe, 2026-08-11, under the old 2-min cron warm). Reads are live per poll
 *  now, which shrinks that blind spot to one poll tick but cannot close it —
 *  a send and an end can still land inside the same tick. */
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
  // has since taken the room.
  //
  // THE BOARD NOW WATCHES THEM TOO, and that is the fix for a bug the owner hit
  // repeatedly on 2026-08-14 ("rooms did not get the returning message again or
  // qualifying"). It used to display the room's NEWEST briefing and nothing
  // else, which is the wrong subject on any busy night: by the time a group
  // walks back, the next group has already been briefed in that room, so the
  // board asked about a heat that had not raced yet and showed nothing at all.
  // Red was sitting idle on the helmet poster with heat 29 briefed and heat 28
  // walking back in. It "worked a couple of times today" — exactly the times no
  // newer group had been through the room yet.
  //
  // So the ends are resolved once here and reused below to pick the subject:
  // the most recent group whose race has actually ENDED.
  const endBySession = new Map<string, number>();
  for (const a of roomTimeline.slice(0, ANNOUNCE_LOOKBACK)) {
    // A group re-sent to a different room has its REAL room in its newest
    // assignment — the stale row in this room's history must not announce the
    // same return a second time (review 2026-08-12). `assignments` is the
    // newest-first list across BOTH rooms.
    const newestForSession = assignments.find(
      (x) => x.sessionId === a.sessionId && x.mode === "timeline",
    );
    if (newestForSession && newestForSession.room !== room) continue;

    // FAST PATH FIRST: the venue broadcast's own RaceFinish, delivered by the
    // bridge seconds after the flag (race-finish.server.ts). When it exists
    // the radio call has normally already fired from the webhook — the
    // announcer's claim makes this a no-op — and Pandora is not consulted.
    const aMarker = await readRaceFinishedMarker(a.sessionId);
    let endMs: number = aMarker ? aMarker.endedAtMs : NaN;
    if (!aMarker) {
      const aTrack: TrackKey =
        a.track === "blue" || a.track === "red" || a.track === "mega" ? a.track : "mega";
      // fresh: live Pandora truth every poll (the 4s reuse window inside the
      // reader still collapses this loop to one upstream read per track, not
      // one per assignment).
      const list = await fetchTrackSessions(aTrack, calendarYmdET(), { fresh: true }).catch(
        () => null,
      );
      const row = list?.find((s) => String(s.sessionId) === a.sessionId);
      endMs = row?.actualEnd ? Date.parse(row.actualEnd) : NaN;
    }
    if (!Number.isFinite(endMs)) continue;
    endBySession.set(a.sessionId, endMs);
    const sinceEnd = Date.now() - endMs;
    if (sinceEnd < -60_000 || sinceEnd > ANNOUNCE_FRESH_MS) continue;
    // Awaited (never throws, 5s timeout): a floating promise on a serverless
    // path can be frozen mid-flight after the response goes out. The cost lands
    // on the one poll per session that wins the claim.
    // `a.track` carries the Mega-day gate (Mega track only, owner 2026-08-12) —
    // the announcer itself decides, so both trigger paths cannot disagree.
    await announceReturnOnce({
      room,
      track: a.track,
      sessionId: a.sessionId,
      heatNumber: a.heatNumber,
    });
  }

  /**
   * THE SUBJECT IS THE GROUP THAT CAME BACK, not the last one briefed.
   *
   * `endBySession` was filled above for the same lookback the announcer uses,
   * newest first, so the first hit is the most recent group whose race actually
   * ended. A group still out — or one briefed but not yet raced, which is the
   * common case on a busy night — simply is not in the map.
   *
   * Rows whose newest assignment is in the OTHER room are skipped there too, so
   * a group re-sent elsewhere cannot be greeted by the room they left.
   */
  const returned = roomTimeline
    .slice(0, ANNOUNCE_LOOKBACK)
    .find((a) => endBySession.has(a.sessionId));
  const subject = returned ?? last;

  const track: TrackKey =
    subject.track === "blue" || subject.track === "red" || subject.track === "mega"
      ? subject.track
      : "mega";

  // Already resolved in the loop above for anything in the lookback; the reads
  // below are the fallback for a subject that fell outside it.
  let actualEndMs: number | null = endBySession.get(subject.sessionId) ?? null;

  // FAST PATH: the venue's own RaceFinish marker means the end is already
  // known — no Pandora read at all. Fallback below is yesterday's behaviour,
  // byte for byte, so a dead bridge only ever costs speed.
  if (actualEndMs === null) {
    const finishMarker = await readRaceFinishedMarker(subject.sessionId);
    actualEndMs = finishMarker ? finishMarker.endedAtMs : null;
  }

  if (actualEndMs === null) {
    // CALENDAR ET day, not the racing business day: the sessions cache is keyed the
    // way its warming cron keys it (todayETRange), and a post-midnight miss only
    // costs the reader its cache — it falls through to a live read on its own.
    const sessions = await fetchTrackSessions(track, calendarYmdET(), { fresh: true }).catch(
      () => null,
    );
    if (!sessions) return null;

    // Compare as STRINGS — the sessions list carries string ids, and the house rule
    // forbids numeric round-trips on Pandora ids regardless.
    const session = sessions.find((s) => String(s.sessionId) === subject.sessionId);
    actualEndMs = session?.actualEnd ? Date.parse(session.actualEnd) : null;
  }

  if (!welcomeBackWindowOpen(Number.isFinite(actualEndMs as number) ? actualEndMs : null)) {
    return null;
  }

  // The last best times, captured off the live socket the first time this runs
  // (the finished heat's standings keep being served until the next heat loads)
  // and read back from Redis every poll after. Heat-number-gated inside — a
  // frame we cannot prove is ours is never recorded.
  const recorded = await loadOrCaptureResults({
    track,
    sessionId: subject.sessionId,
    heatNumber: subject.heatNumber,
  }).catch(() => null);

  const target = nextLevelTarget(track, subject.raceType);
  const split = recorded ? splitByTarget(recorded.drivers, target?.ms ?? null) : null;

  return {
    heatNumber: subject.heatNumber,
    raceType: subject.raceType,
    track,
    endedAtMs: actualEndMs as number,
    results: split
      ? {
          // bestMs is non-null for every qualifier by construction (a driver
          // with no lap cannot beat a target), hence the assertion.
          levelledUp: split.levelledUp.map((d) => ({ name: d.name, bestMs: d.bestMs as number })),
          keepPushing: split.keepPushing.map((d) => ({ name: d.name, bestMs: d.bestMs })),
        }
      : null,
  };
}
