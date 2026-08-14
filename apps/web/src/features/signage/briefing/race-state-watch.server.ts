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
