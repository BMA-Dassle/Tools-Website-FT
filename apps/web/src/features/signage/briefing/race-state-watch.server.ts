import "server-only";

/**
 * THE PAUSE WATCHER — samples each track's run state once a minute, publishes
 * which heat each track is on, and marks the cameras on a pause or resume WHEN
 * NOTHING BETTER IS AVAILABLE.
 *
 * ─── THIS USED TO BE THE ONLY WAY. IT NO LONGER IS. ───────────────────────
 *
 * The original note here said a pause "is pushed nowhere… so it gets polled",
 * and that was true when it was written. It is not true now: a survey of the
 * venue broadcast on 2026-08-16 found `SessionPausedNotification` and
 * `SessionResumedNotification` flowing with the venue's OWN timestamp — the
 * exact thing this sampler was built to approximate. They are handled on the
 * webhook by racing/track-events.server.ts, seconds after the event rather than
 * up to a minute later.
 *
 * So the bookmarking here is now a FALLBACK, gated on the bridge's heartbeat
 * (racing/timing-feed.server.ts): it marks only while the feed is NOT live. When
 * the bridge is healthy the exact stamp wins and this stands down; when the
 * bridge dies — as it did silently for seven hours on 2026-08-14 — this is what
 * keeps the ribbon annotated. The gate also keeps the two paths from
 * double-marking, which they otherwise would, since they key their claims
 * differently (`heat-{n}` here, the real session id there).
 *
 * WHAT SAMPLING COSTS, SAID PLAINLY, because it still applies whenever this
 * fires: a pause shorter than the interval can be missed entirely, and one that
 * IS caught carries a timestamp up to a minute late. Both are handled rather
 * than hidden — the marker's range leads in two minutes
 * (race-bookmarks.server.ts) and its description says the moment is
 * approximate.
 *
 * ─── THE PART THAT IS NOT A FALLBACK ──────────────────────────────────────
 *
 * `race:live-heat:{track}` below is published unconditionally and must stay
 * that way. It is the pit lane's SECOND OPINION and its whole value is that it
 * does not come through the bridge — gating it on the bridge's health would
 * remove exactly the cover it exists to provide.
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
import { readTimingFeedStatus } from "~/features/racing/timing-feed.server";
import { recordTrackEvent } from "~/features/racing/data/track-events-db";
import type { TrackKey } from "../track";

/** ALL THREE, mega last. The old fear — that sampling mega as well would
 *  double-mark every Mega pause because the `-1` resource reports the same
 *  heat the two track feeds do — was unfounded: the bookmark claim is NX per
 *  (heat, phase) with NO track in the key (race-bookmarks.server.ts), so
 *  whichever watcher sees the transition first wins and the others' claims
 *  reject. Mega goes LAST so on a normal day blue/red claim their own
 *  transitions first and camera scope stays exactly as before; on a Mega
 *  night, if the blue/red sockets go quiet, the mega feed still writes
 *  `race:live-heat:mega` — the pit lane's stuck-group recovery signal, which
 *  simply did not exist for the combined circuit before (2026-08-16). */
const WATCHED: TrackKey[] = ["blue", "red", "mega"];

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
  /** The bridge heartbeat this run decided on. Reported so a dryRun answers
   *  "why did it not mark?" without a second query. */
  feedState: string;
  /** True when the feed was live and the webhook is therefore the one marking. */
  pushCovering: boolean;
  tracks: RaceStateWatchTrack[];
}

export async function runRaceStateWatch(
  opts: { dryRun?: boolean } = {},
): Promise<RaceStateWatchResult> {
  const enabled = await raceBookmarksEnabled();
  /**
   * STAND DOWN WHILE THE PUSH PATH IS WORKING. `live` means the bridge
   * delivered something within the last 90 seconds, which is precisely the
   * window in which a pause notification would have reached
   * track-events.server.ts with the venue's exact stamp. `stale`, `down` and
   * `unknown` all mean we cannot count on that, so the sampler covers.
   *
   * Erring towards sampling on `unknown` is deliberate: a duplicate marker is
   * recoverable, an unmarked incident is not.
   */
  const feed = await readTimingFeedStatus();
  const pushCovering = feed.state === "live";
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
    if (transition && pushCovering) {
      // The webhook already marked this with the venue's own stamp — or will
      // within seconds. Said in the note rather than silently skipped, so a
      // dryRun still shows what the sampler SAW.
      note = `push covering (feed ${feed.state}, ${Math.round((feed.ageMs ?? 0) / 1000)}s)`;
    } else if (transition && !enabled) {
      note = "switched off";
    } else if (transition && opts.dryRun) {
      note = "would mark (dry run)";
    } else if (transition) {
      const atMs = Date.now();
      camerasMarked = await bookmarkRaceEvent({
        track,
        // The heat number is the id we have here; the socket frame carries no
        // Pandora session id, so the claim key is keyed on the heat instead.
        // Unique within a night, which is all the claim's TTL needs.
        sessionId: `heat-${frame.heatNumber}`,
        heatNumber: frame.heatNumber,
        heatName: frame.heatName || null,
        phase: transition,
        atMs,
        sampled: true,
      }).catch((err) => {
        console.error(`[race-state-watch] ${track} ${transition} bookmark failed`, err);
        return 0;
      });
      /**
       * LOG IT TOO, so the incident record does not go blank exactly when the
       * bridge does — which is the only time this branch runs.
       *
       * `session_id` is left NULL on purpose: `heat-{n}` above is a claim key,
       * not a Pandora session id, and putting it in that column would be a
       * fabricated identifier in a safety log. The heat number carries the
       * identity instead, and `source: "sampled"` says the stamp is within the
       * preceding minute rather than exact.
       */
      await recordTrackEvent({
        track,
        action: transition,
        atMs,
        sessionId: null,
        heatNumber: frame.heatNumber,
        heatName: frame.heatName || null,
        camerasMarked,
        source: "sampled",
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

  return { ok: true, enabled, feedState: feed.state, pushCovering, tracks };
}
