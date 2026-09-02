import "server-only";

/**
 * Resolve the race results board for one track: WHICH race just finished, and
 * what happened in it.
 *
 * WHY THIS NEEDS ITS OWN RESOLVER. The welcome-back resolver next door answers
 * a room's question — "which group briefed HERE has come back" — off
 * `briefing_assignments`. A results board has no room and no assignment: it
 * speaks for a TRACK, and it must show the last race on it whether or not that
 * race was ever briefed. Walk-up races, group events and staff-inserted heats
 * all belong on it.
 *
 * THREE SOURCES, BECAUSE NO ONE OF THEM IS COMPLETE:
 *
 *   1. Pandora's session list, read fresh — current, authoritative about
 *      `actualEnd`, and the source that carries races nothing else has seen.
 *      It does NOT carry the heat's name, so it cannot say what race type ran.
 *   2. Neon `race_timings` — carries the heat NAME (hence the race type, hence
 *      the qualifying target) and survives a Pandora outage. Written from the
 *      venue broadcast, so it fills in when the bridge delivers and BACKFILLS
 *      a missed night when the bridge replays.
 *   3. The Redis finish markers — seconds-fresh, and the only thing that knows
 *      a race is over during the ~40s before Pandora stamps `actualEnd`. Keyed
 *      by session id, so it can only be consulted once 1 or 2 have named the
 *      session.
 *
 * WHY THE BOARD CAPTURES AT ALL. The webhook already captures standings for
 * every stamped finish, but only inside a 10-minute freshness window, and the
 * bridge delivers in bursts 5-90 minutes apart — on 2026-08-13 only 6 of 18
 * sessions got a marker. A board that only read what the webhook managed to
 * catch would be blank most of the night. So the newest finished race gets a
 * capture ATTEMPT here on every rebuild. `loadOrCaptureResults` short-circuits
 * on a stored record and holds its own 8s claim, so the attempt is free once
 * it has landed — and it gives the capture more chances to reach the frame
 * before staff load the next heat, which helps the briefing wall too.
 *
 * Fails to null throughout. A results board with a broken upstream shows its
 * idle card, never an error.
 */
import redis from "@/lib/redis";
import { calendarYmdET } from "@/lib/race-business-day";
import { fetchTrackSessions } from "~/features/reservations-admin/race-live-state.server";
import { listRaceTimings } from "~/features/racing/data/race-timings-db";
import { loadOrCaptureResults } from "../briefing/race-results.server";
import { readRaceFinishedMarker } from "../briefing/race-finish.server";
import { megaModeActive } from "./mega-mode.server";
import {
  buildResultsView,
  mergeCandidates,
  rankFinished,
  type FinishedCandidate,
  type ResultsBoardView,
} from "../results-board";
import type { TrackKey } from "../track";
import type { SignageVenue } from "../constants";

/**
 * How many finished races back the board will look for one it can actually
 * name. A capture legitimately misses — the heat-match gate refuses a frame it
 * cannot prove is ours, and a group event has no parseable heat number — and
 * the honest answer to that is the newest race we DO have, not a heat number
 * with an empty table under it.
 *
 * Three is a judgement, not a measurement: it covers a couple of consecutive
 * misses without ever showing something an hour stale as though it were the
 * race that just came in. One race night on preview will say whether it should
 * shrink.
 */
const WALK_BACK = 3;

/**
 * How many still-running sessions get a finish-marker lookup.
 *
 * Only the tail of the day can be mid-flight, and each lookup is a Redis GET.
 * Bounded so a day with a long list of unstamped sessions (the orphan-session
 * quirk — a session whose `actualEnd` never lands) cannot turn one rebuild
 * into fifty reads.
 */
const MARKER_PROBE_LIMIT = 6;

/** One build per track per this many seconds, however many screens are asking.
 *  Results change once every ~10 minutes; the 15s feed is already generous. */
const CACHE_TTL_SECONDS = 12;

function cacheKey(venue: SignageVenue, track: TrackKey): string {
  return `signage:results-board:${venue}:${track}`;
}

/**
 * The board for one track, cached per venue+track.
 *
 * Null means "no race has finished on this track today that we can name" —
 * the scene's idle state, not an error. A failed rebuild also returns null
 * rather than throwing: there is no error state on a wall.
 */
export async function resolveResultsBoard(
  venue: SignageVenue,
  track: TrackKey,
  businessDay: string,
): Promise<ResultsBoardView | null> {
  const key = cacheKey(venue, track);

  try {
    const cached = await redis.get(key);
    if (cached) {
      // A cached MISS is stored as the empty string: "we looked, there is
      // nothing" is just as much worth not recomputing as a hit, and on a
      // quiet morning it is the answer every screen is asking for.
      if (cached === "") return null;
      return JSON.parse(cached) as ResultsBoardView;
    }
  } catch {
    /* unreadable cache → rebuild below */
  }

  let view: ResultsBoardView | null = null;
  try {
    view = await buildBoard(venue, track, businessDay);
  } catch {
    // An upstream having a bad moment must not be cached as "nothing today" —
    // return without writing, so the next poll tries again immediately.
    return null;
  }

  try {
    await redis.set(key, view ? JSON.stringify(view) : "", "EX", CACHE_TTL_SECONDS);
  } catch {
    /* served this one from memory; the next poll rebuilds */
  }
  return view;
}

/** Pandora's session list for one track, as candidates. It carries no heat
 *  NAME, so that field stays null for race_timings to supply. */
function pandoraCandidates(
  sessions: Awaited<ReturnType<typeof fetchTrackSessions>>,
  track: TrackKey,
): FinishedCandidate[] {
  return (sessions ?? []).map((s) => ({
    sessionId: String(s.sessionId),
    heatNumber: typeof s.heatNumber === "number" ? s.heatNumber : null,
    heatName: null,
    endedAtMs: s.actualEnd ? Date.parse(s.actualEnd) : null,
    track,
  }));
}

async function buildBoard(
  venue: SignageVenue,
  track: TrackKey,
  businessDay: string,
): Promise<ResultsBoardView | null> {
  // CALENDAR ET day for Pandora, business day for Neon — deliberately
  // different. The sessions cache is keyed the way its warming cron keys it
  // (todayETRange), while a race that runs past midnight belongs to the night
  // it started. Each source is asked in its own frame.
  //
  // Neon first, alone, because it decides whether the second Pandora read below
  // is worth making. It is one indexed query against a table this resolver was
  // already reading.
  const timings = await listRaceTimings(venue, businessDay).catch(() => []);

  /**
   * THIS BOARD'S OWN TRACK, PLUS MEGA.
   *
   * On a Mega day the barrier between Blue and Red comes out and every race
   * runs on the combined circuit, so a wall that only ever asked about its own
   * resource would sit on its idle card all night — the busiest night of the
   * week, at the kart return, in front of the group whose result it exists to
   * show. `rankFinished` then picks whichever of the two ended most recently;
   * see the rule and its cases in results-board.ts.
   *
   * The extra Pandora read is paid ONLY when Mega could plausibly have run.
   * `timings` above spans every track, so a Mega row in it is free evidence;
   * the flag covers the one case Neon cannot know about yet — a Mega race that
   * finished in the last few minutes and has not been delivered by the bridge.
   * On an ordinary day neither holds and this costs nothing.
   */
  const megaRelevant =
    track !== "mega" &&
    (timings.some((t) => t.track === "mega") || (await megaModeActive().catch(() => false)));

  const [sessions, megaSessions] = await Promise.all([
    fetchTrackSessions(track, calendarYmdET(), { fresh: true }).catch(() => null),
    megaRelevant
      ? fetchTrackSessions("mega", calendarYmdET(), { fresh: true }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const fromPandora = pandoraCandidates(sessions, track);
  const fromPandoraMega = pandoraCandidates(megaSessions, "mega");

  const fromNeon: FinishedCandidate[] = timings
    // race_timings spans every track; this board speaks for its own and Mega.
    .filter((t) => t.track === track || t.track === "mega")
    .map((t) => ({
      sessionId: t.sessionId,
      heatNumber: t.heatNumber,
      heatName: t.heatName,
      endedAtMs: t.endedAtMs,
      track: t.track as TrackKey,
    }));

  const merged = mergeCandidates([fromPandora, fromPandoraMega, fromNeon]);

  /**
   * WHICH ENDS ARE STAMPED, decided BEFORE the marker probe below fills any
   * in. Pandora's actualEnd and race_timings' ended_at are the venue's own
   * stamp — the race is fully over and its standings final. A marker-filled
   * end is the phase-one push, ~40s early, while karts are still completing
   * their last lap — final enough to rank on, NOT final enough to unlock the
   * fallback standings sources (see loadOrCaptureResults.stampedEndMs).
   */
  const stampedEnds = new Map<string, number>();
  for (const c of merged) {
    if (c.endedAtMs !== null) stampedEnds.set(c.sessionId, c.endedAtMs);
  }

  /**
   * THE FAST PATH, and the only reason a just-finished race reaches this wall
   * before Pandora stamps it: the venue broadcast's own finish marker, ~40s
   * ahead of the stamp. Probed only for sessions still showing as unfinished,
   * newest scheduled first, and bounded — see MARKER_PROBE_LIMIT.
   */
  const unfinished = merged.filter((c) => c.endedAtMs === null).slice(-MARKER_PROBE_LIMIT);
  if (unfinished.length > 0) {
    const markers = await Promise.all(
      unfinished.map((c) => readRaceFinishedMarker(c.sessionId).catch(() => null)),
    );
    unfinished.forEach((c, i) => {
      const m = markers[i];
      if (!m) return;
      c.endedAtMs = m.endedAtMs;
      c.heatNumber = c.heatNumber ?? m.heatNumber;
      c.heatName = c.heatName ?? m.heatName;
    });
  }

  const ranked = rankFinished(merged).slice(0, WALK_BACK);
  if (ranked.length === 0) return null;

  for (let i = 0; i < ranked.length; i++) {
    const race = ranked[i];
    // Only the NEWEST race is plausibly still on the timing wire, so only it
    // gets the socket grab (`wire`); older races go through the same call with
    // the wire off — opening a socket per stale race per poll just gets told
    // the frame is a different heat. The fallback sources (Pandora scores,
    // race_best_laps) are addressed by session id, so they apply to every
    // stamped race in the walk-back — which is what kept this wall alive
    // through the 2026-09-01 cloud-socket outage's shape of failure.
    const recorded = await loadOrCaptureResults({
      // The RACE's track, not the board's: the capture reads that track's
      // timing feed, and asking Blue's feed for a Mega heat would capture
      // nothing at all.
      track: race.track,
      sessionId: race.sessionId,
      heatNumber: race.heatNumber,
      stampedEndMs: stampedEnds.get(race.sessionId) ?? null,
      heatName: race.heatName,
      wire: i === 0,
    }).catch(() => null);

    if (!recorded || recorded.drivers.length === 0) continue;

    return buildResultsView({
      // Likewise the race's own track, so a Mega heat on a Blue-labelled wall
      // is captioned and coloured MEGA rather than Blue.
      track: race.track,
      sessionId: race.sessionId,
      heatNumber: race.heatNumber,
      // The capture's own heatName is the timing system's, which is the same
      // string race_timings holds; either will do, and one of them exists.
      heatName: race.heatName ?? recorded.heatName ?? null,
      endedAtMs: race.endedAtMs as number,
      drivers: recorded.drivers,
    });
  }

  // Races ran, but none of them has standings we can stand behind. The board
  // shows its idle card rather than a heat number over an empty table.
  return null;
}
