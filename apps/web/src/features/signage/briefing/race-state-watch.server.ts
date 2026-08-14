import "server-only";

/**
 * THE PAUSE WATCHER — samples each track's run state once a minute and marks
 * the cameras when a race pauses or resumes.
 *
 * WHY A SAMPLER AND NOT AN EVENT. Three of the four race events the owner asked
 * for arrive on the venue broadcast with the venue's own timestamp: RaceStart
 * and RaceFinish are pushed to our webhook within seconds of the flag, and
 * race-finish.server.ts marks the cameras straight off them. A PAUSE is pushed
 * nowhere. It exists only as the `S` field on the SMS-Timing socket frame
 * (1 running · 2 paused), which is a state you can read but not subscribe to
 * from a serverless function. So it gets polled.
 *
 * WHAT THAT COSTS, SAID PLAINLY: a pause shorter than the sampling interval can
 * be missed entirely, and a pause that IS caught carries a timestamp up to a
 * minute late. Both are handled rather than hidden — the marker's range leads
 * in two minutes (race-bookmarks.server.ts) so the footage behind it contains
 * the actual incident, and its description says the moment is approximate. A
 * bookmark that silently implied second-accuracy would send somebody to the
 * wrong minute of an incident review.
 *
 * WHY IT IS STILL WORTH HAVING: a pause in karting is almost always an
 * incident — a spin, a stall, a marshal on the circuit — and those are exactly
 * the moments an insurance question is later about. Most of them last well over
 * a minute, so most of them are caught.
 *
 * COST: two websocket connects a minute, each sub-second, only while a track
 * has a race loaded. A track sitting empty settles to `none` and stops being
 * interesting, but is still sampled — the connect is cheaper than the state
 * needed to decide not to.
 */
import redis from "@/lib/redis";
import { captureTrackState } from "./results-capture.server";
import { raceStateTransition, type RaceStateMemory, type RaceTransition } from "./race-state";
import { bookmarkRaceEvent } from "./race-bookmarks.server";
import { raceBookmarksEnabled } from "./race-bookmarks-setting.server";
import type { TrackKey } from "../track";

/** Blue and red only. Mega runs the joined circuit and is served by the `-1`
 *  resource, which reports the same heat the two track feeds do — sampling it
 *  as well would double-mark every Mega pause. */
const WATCHED: TrackKey[] = ["blue", "red"];

/** Outlives the gap between samples many times over, so a slow minute cannot
 *  make the watcher forget a running race and miss its resume. */
const MEMORY_TTL_SECONDS = 6 * 3600;

function memoryKey(track: TrackKey): string {
  return `race:state:${track}`;
}

/**
 * WHAT HEAT THE TRACK IS ACTUALLY ON — published for the pit lane.
 *
 * WHY (owner 2026-08-14, live): "18 is stuck in holding and never moved to
 * racing." The lane promotes holding→racing off the venue broadcast's finish
 * marker and has no other way to learn a race happened, so when the kart bridge
 * stops delivering — as it did from 07:02 that day, silent for seven hours while
 * heats kept running — every group that goes to the seats stays there on the
 * board forever, and the group before them stays "on track" forever.
 *
 * This is the second opinion. The watcher is already connected to the timing
 * socket once a minute for pause detection, and that same frame says which heat
 * the track is on. A LATER heat being loaded is proof the earlier one is over,
 * whatever the broadcast did or did not tell us. Published as a plain Redis key
 * so the lane can read it on its 2-second pulse for the cost of one GET rather
 * than a websocket connect it could never afford.
 *
 * TEN MINUTES OF TTL, deliberately short: a stale "the track is on heat 40" is
 * exactly the input that would wrongly retire a group, so the reader must be
 * able to tell fresh from old, and an absent key must mean "no opinion".
 */
const LIVE_HEAT_TTL_SECONDS = 600;

export function liveHeatKey(track: TrackKey): string {
  return `race:live-heat:${track}`;
}

export interface LiveHeat {
  heatNumber: number;
  state: string;
  atMs: number;
}

async function publishLiveHeat(track: TrackKey, heatNumber: number, state: string): Promise<void> {
  try {
    await redis.set(
      liveHeatKey(track),
      JSON.stringify({ heatNumber, state, atMs: Date.now() } satisfies LiveHeat),
      "EX",
      LIVE_HEAT_TTL_SECONDS,
    );
  } catch {
    /* the lane simply has no second opinion this minute */
  }
}

async function readMemory(track: TrackKey): Promise<RaceStateMemory | null> {
  try {
    const raw = await redis.get(memoryKey(track));
    if (!raw) return null;
    const p = JSON.parse(raw) as RaceStateMemory;
    return p && typeof p.state === "string" ? p : null;
  } catch {
    return null;
  }
}

async function writeMemory(track: TrackKey, memory: RaceStateMemory): Promise<void> {
  try {
    await redis.set(memoryKey(track), JSON.stringify(memory), "EX", MEMORY_TTL_SECONDS);
  } catch {
    /* the next sample re-establishes it; a lost memory costs one transition */
  }
}

export interface RaceStateWatchTrack {
  track: TrackKey;
  heatNumber: number | null;
  state: string;
  transition: RaceTransition;
  camerasMarked: number;
  note?: string;
}

export interface RaceStateWatchResult {
  ok: true;
  enabled: boolean;
  tracks: RaceStateWatchTrack[];
}

export async function runRaceStateWatch(
  opts: { dryRun?: boolean } = {},
): Promise<RaceStateWatchResult> {
  const enabled = await raceBookmarksEnabled();
  const tracks: RaceStateWatchTrack[] = [];

  for (const track of WATCHED) {
    const frame = await captureTrackState(track).catch(() => null);
    if (!frame) {
      // UNREADABLE, NOT EMPTY. The memory is deliberately left untouched: a
      // socket blip must not be remembered as "the race stopped existing",
      // which would fabricate a transition on the next good sample.
      tracks.push({
        track,
        heatNumber: null,
        state: "unreadable",
        transition: null,
        camerasMarked: 0,
        note: "no frame — memory left as-is",
      });
      continue;
    }

    const prev = await readMemory(track);
    const transition = raceStateTransition(prev, frame);
    const next: RaceStateMemory = { heatNumber: frame.heatNumber, state: frame.state };

    // The lane's second opinion — published whenever the socket names a heat,
    // regardless of whether anything transitioned. Not published on `none`: an
    // empty track between heats has no opinion to offer and must not blank the
    // last good one, which is why this is a set-with-TTL and never a delete.
    if (frame.heatNumber != null) await publishLiveHeat(track, frame.heatNumber, frame.state);

    let camerasMarked = 0;
    let note: string | undefined;
    if (transition && !enabled) {
      note = "switched off";
    } else if (transition && opts.dryRun) {
      note = "would mark (dry run)";
    } else if (transition) {
      camerasMarked = await bookmarkRaceEvent({
        track: track as "blue" | "red",
        // The heat number is the id we have here; the socket frame carries no
        // Pandora session id, so the claim key is keyed on the heat instead.
        // Unique within a night, which is all the claim's TTL needs.
        sessionId: `heat-${frame.heatNumber}`,
        heatNumber: frame.heatNumber,
        heatName: frame.heatName || null,
        phase: transition,
        atMs: Date.now(),
        sampled: true,
      }).catch((err) => {
        console.error(`[race-state-watch] ${track} ${transition} bookmark failed`, err);
        return 0;
      });
    }

    // Written AFTER the marker, so a crash between the two re-tries the same
    // transition next minute rather than swallowing it. The bookmark's own NX
    // claim makes that retry harmless.
    await writeMemory(track, next);

    tracks.push({
      track,
      heatNumber: frame.heatNumber,
      state: frame.state,
      transition,
      camerasMarked,
      ...(note ? { note } : {}),
    });
  }

  return { ok: true, enabled, tracks };
}
