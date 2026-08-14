import "server-only";

/**
 * The FAST end-of-race path (owner 2026-08-12: "the way we get the session end
 * is still way too slow — let's do the race finished from here").
 *
 * "Here" is the venue timing server's own broadcast, delivered in real time by
 * kart-timing-bridge → /api/webhooks/kart-timing-event. When a fresh
 * `RaceFinish` arrives, this module — on the webhook's request, seconds after
 * the chequered flag instead of ~40s of Pandora stamp lag plus our polling:
 *
 *   1. writes a `briefing:race-finished:{sessionId}` marker the welcome-back
 *      resolver reads INSTEAD of polling Pandora (RaceId and sessionId are the
 *      same id space — verified exact match on real assignments),
 *   2. captures the final standings off the timing cloud socket the moment
 *      the STAMPED end arrives — the heat is still on the wire and its laps
 *      are final, which retires the "grab it before the next heat loads"
 *      gamble (the venue broadcast itself carries rosters but NO lap times —
 *      LapCount never fills in; surveyed 2026-08-12),
 *   3. fires the "{heat} returning to {room}" radio call if this race was
 *      briefed in one of our rooms AND ran on the Mega track (the announcement
 *      is Mega-only — see return-announce.server.ts).
 *
 * EVERY LAYER BELOW STILL STANDS. The Pandora actualEnd path keeps working
 * untouched, so a bridge outage (the pipe had a 2.5h hole on 8/11) degrades to
 * exactly the behaviour shipped yesterday — never worse, only slower.
 *
 * Never throws: this rides an ingest webhook whose 200 must not depend on us.
 */
import redis from "@/lib/redis";
import { businessDayYmdET } from "@/lib/race-business-day";
import {
  extractRaceFinishes,
  extractRaceStarts,
  isActionableFinish,
} from "~/features/racing/venue-broadcast";
import { recordRaceTiming } from "~/features/racing/data/race-timings-db";
import { listBriefingAssignments } from "./assignments-db";
import { announceReturnOnce } from "./return-announce.server";
import { loadOrCaptureResults } from "./race-results.server";
import { bookmarkRaceEvent } from "./race-bookmarks.server";
import { raceBookmarksEnabled } from "./race-bookmarks-setting.server";
import { parseCameraTrack } from "../nx/track-cameras";

export interface RaceFinishedMarker {
  /** The venue's ActualEnd when stamped; our receive time during the
   *  pending-finish window (the unstamped push can beat the stamp by ~40s). */
  endedAtMs: number;
  heatNumber: number | null;
  heatName: string;
  track: string | null;
}

/** Outlives any welcome-back window; short enough that Redis stays display
 *  state, not an archive. */
const MARKER_TTL_SECONDS = 12 * 3600;

export function raceFinishedKey(sessionId: string): string {
  return `briefing:race-finished:${sessionId}`;
}

/**
 * "This session went green" — the start-side twin of the finish marker,
 * written by recordRaceStarts below. The pit lane resolves on it: a holding
 * group whose session has this marker IS the racing group, and the pit board
 * rolls to the next session (pit/lane.server.ts).
 */
export function raceStartedKey(sessionId: string): string {
  return `pit:race-started:${sessionId}`;
}

export async function readRaceStartedMarker(sessionId: string): Promise<number | null> {
  if (!sessionId) return null;
  try {
    const raw = await redis.get(raceStartedKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { atMs?: number };
    return typeof parsed.atMs === "number" && Number.isFinite(parsed.atMs) ? parsed.atMs : null;
  } catch {
    return null;
  }
}

/** The resolver's fast path: the venue's own end signal, if it has arrived. */
export async function readRaceFinishedMarker(
  sessionId: string,
): Promise<RaceFinishedMarker | null> {
  if (!sessionId) return null;
  try {
    const raw = await redis.get(raceFinishedKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RaceFinishedMarker;
    return Number.isFinite(parsed.endedAtMs) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write down every race start in a message.
 *
 * Claimed per race so the same start re-arriving (the broadcast repeats itself,
 * and a reconnect replays the buffer) costs one Neon write rather than one per
 * push. A start stamp never changes, so the claim needs no version in its key —
 * unlike the finish claim, where a pending end really does get superseded.
 *
 * Never throws: this is metrics riding an ingest webhook.
 */
async function recordRaceStarts(message: unknown): Promise<void> {
  for (const s of extractRaceStarts(message)) {
    if (s.actualStartMs === null) continue;
    // THE GREEN-FLAG MARKER the pit boards resolve on — see raceStartedKey
    // above. NX + written before the claim below, so a replayed race list can
    // never slide the flag forward and a marker can never be lost to a
    // duplicate-claim skip.
    await redis
      .set(
        raceStartedKey(s.raceId),
        JSON.stringify({ atMs: s.actualStartMs }),
        "EX",
        12 * 3600,
        "NX",
      )
      .catch(() => void 0);
    const claim = await redis
      .set(`race-timing:${s.raceId}:start`, "1", "EX", 36 * 3600, "NX")
      .catch(() => null);
    if (claim !== "OK") continue;
    await recordRaceTiming({
      sessionId: s.raceId,
      track: s.track,
      heatNumber: s.heatNumber,
      heatName: s.heatName || null,
      startedAtMs: s.actualStartMs,
      endedAtMs: null,
    }).catch((err) => console.error("[race-timings] start write failed", err));

    /**
     * MARK THE TRACK'S CAMERAS (owner 2026-08-14). Riding the venue's own
     * ActualStart, so this marker sits on the flag rather than on whenever we
     * happened to process the push.
     *
     * INSIDE the timing claim on purpose: that claim is already "the first time
     * we have seen this race start", which is exactly once per race, and it is
     * the same guard that stops the day's replayed race list from writing this
     * marker to eighteen cameras several hundred times a night. bookmarkRaceEvent
     * takes its own claim underneath as well — belt and braces, because the cost
     * of getting this wrong is spread across every camera on the track.
     */
    await markRaceCameras({
      track: s.track,
      sessionId: s.raceId,
      heatNumber: s.heatNumber,
      heatName: s.heatName || null,
      phase: "start",
      atMs: s.actualStartMs,
    });
  }
}

/**
 * Bookmark a race event across its track's cameras, gated on the kill switch.
 *
 * Wrapped rather than called directly so the switch check and the swallow live
 * in one place: this runs inside a webhook that also fires the return radio,
 * and a camera system having a bad night must never reach that.
 */
async function markRaceCameras(args: {
  track: string | null;
  sessionId: string;
  heatNumber: number | null;
  heatName: string | null;
  phase: "start" | "end";
  atMs: number;
}): Promise<void> {
  try {
    const track = parseCameraTrack(args.track);
    if (!track) return;
    if (!(await raceBookmarksEnabled())) return;
    await bookmarkRaceEvent({
      track,
      sessionId: args.sessionId,
      heatNumber: args.heatNumber,
      heatName: args.heatName,
      phase: args.phase,
      atMs: args.atMs,
    });
  } catch (err) {
    console.error(`[race-bookmark] ${args.phase} failed`, err);
  }
}

/**
 * Act on one webhook message. The broadcast re-sends the whole day's race list
 * on every state change and replays it in reconnect catch-up dumps, so this is
 * gated three deep: the freshness rule (pure, tested), a per-race NX claim,
 * and the announcer's own per-(room,session) claim underneath.
 */
export async function handleVenueMessage(message: unknown): Promise<void> {
  try {
    /**
     * THE FLAG DROPPING, RECORDED AS IT HAPPENS (owner 2026-08-12: "don't we have
     * race start from the karting websocket?").
     *
     * We do — the bridge forwards `RaceStart`, and until now nothing here read
     * it. A finish carries ActualStart too, but only once the race is OVER, so a
     * race's start time was unknown for the whole seven minutes it was being run.
     * This lands it within seconds of the flag; the finish later completes the
     * same row (the upsert COALESCEs, so neither can blank the other).
     *
     * Handled BEFORE the finish loop and independently of it — a message can
     * carry starts and no finishes at all, which the old early-return dropped.
     */
    await recordRaceStarts(message);

    const finishes = extractRaceFinishes(message);
    if (finishes.length === 0) return;
    const nowMs = Date.now();

    for (const f of finishes) {
      /**
       * THE ARCHIVE WRITE, AHEAD OF THE FRESHNESS GATE AND ON PURPOSE.
       *
       * Everything below this line is a live effect — a marker a wall reads, a
       * radio call, a standings capture — and all of it is rightly inert for a
       * race that finished hours ago. The timing row is the opposite: it is
       * history, so a replayed race list is exactly how a bridge outage
       * BACKFILLS the night it missed (the pipe had a 2.5h hole on 8/11). The
       * upsert COALESCEs, so a replay can only ever fill a gap.
       *
       * Claimed per (race, end stamp) so the day's list re-arriving on every
       * state change costs one Neon write per race, not one per push — and a
       * CHANGED end stamp still gets through, because the claim key carries it.
       */
      if (f.actualEndMs !== null || f.actualStartMs !== null) {
        const claim = await redis
          .set(`race-timing:${f.raceId}:${f.actualEndMs ?? "pending"}`, "1", "EX", 36 * 3600, "NX")
          .catch(() => null);
        if (claim === "OK") {
          await recordRaceTiming({
            sessionId: f.raceId,
            track: f.track,
            heatNumber: f.heatNumber,
            heatName: f.heatName || null,
            startedAtMs: f.actualStartMs,
            endedAtMs: f.actualEndMs,
          }).catch((err) => {
            // Metrics data, not a guest-facing effect: a Neon blip must never
            // cost the radio call or the standings capture below it.
            console.error("[race-timings] write failed", err);
          });
        }
      }

      /**
       * THE END MARKER, on the venue's own ActualEnd.
       *
       * Only off a STAMPED finish, and outside the claim above. The pending
       * window pushes `State:"Finished"` ~40s before ActualEnd is stamped
       * (see the schema note in reference_venue_timing_broadcast_schema), so
       * marking on the unstamped push would put every session's end marker
       * forty seconds early — on eighteen cameras, for every race of the night.
       * The stamped push follows within a minute and bookmarkRaceEvent's own
       * per-(race, phase) claim makes it exactly once.
       *
       * Deliberately ABOVE the isActionableFinish gate below: that gate is
       * about live effects a stale race must not trigger, and this is archive
       * annotation. A replayed list from a bridge outage SHOULD backfill the
       * markers it missed, exactly as the timing row above it does.
       */
      if (f.actualEndMs !== null) {
        await markRaceCameras({
          track: f.track,
          sessionId: f.raceId,
          heatNumber: f.heatNumber,
          heatName: f.heatName || null,
          phase: "end",
          atMs: f.actualEndMs,
        });
      }

      if (!isActionableFinish(f, nowMs)) continue;

      const marker: RaceFinishedMarker = {
        endedAtMs: f.actualEndMs ?? nowMs,
        heatNumber: f.heatNumber,
        heatName: f.heatName,
        track: f.track,
      };
      // A STAMPED marker carries the venue's own end time — a stable value,
      // safe to overwrite (it also upgrades an earlier unstamped marker). An
      // UNSTAMPED one carries our receive time, so it writes NX-only: replayed
      // race-list pushes must neither slide it forward nor clobber the real
      // stamp with a fabricated "just now" (review 2026-08-12).
      if (f.actualEndMs !== null) {
        await redis
          .set(raceFinishedKey(f.raceId), JSON.stringify(marker), "EX", MARKER_TTL_SECONDS)
          .catch(() => void 0);
      } else {
        await redis
          .set(raceFinishedKey(f.raceId), JSON.stringify(marker), "EX", MARKER_TTL_SECONDS, "NX")
          .catch(() => void 0);
      }

      // RADIO FIRST — the time-critical, human-facing effect, and the one a
      // platform kill mid-handler must lose last. The claim only spares the
      // Neon lookup on the replayed pushes that re-carry this finish all
      // night; once-only is still the announcer's own per-(room,session)
      // claim underneath.
      const claimed = await redis
        .set(`briefing:finish-announce:${f.raceId}`, "1", "EX", 24 * 3600, "NX")
        .catch(() => null);
      if (claimed === "OK") {
        const assignments = await listBriefingAssignments("FT", businessDayYmdET()).catch(() => []);
        // Newest-first list: a re-sent group's REAL room is its latest send.
        const briefed = assignments.find((a) => a.sessionId === f.raceId && a.mode === "timeline");
        if (briefed) {
          await announceReturnOnce({
            room: briefed.room,
            // The SEND ROW's track, not the broadcast's `f.track`, so this path
            // and the TV-poll path feed the Mega-day gate the same value.
            track: briefed.track,
            sessionId: briefed.sessionId,
            heatNumber: briefed.heatNumber,
          });
        }
      }

      // FINAL standings — only off a STAMPED finish. During the pending
      // window (unstamped) karts are still completing their last lap, and a
      // capture then would freeze pre-final laps into the qualification board
      // for 48h (review 2026-08-12). The stamped push follows within ~a
      // minute, the frame is still on the wire, and loadOrCaptureResults
      // self-dedupes (stored record short-circuits; 8s attempt claim), so
      // every later push and TV poll is a free retry rather than a burned
      // one-shot.
      if (f.actualEndMs !== null && f.track !== null && f.heatNumber !== null) {
        await loadOrCaptureResults({
          track: f.track as "blue" | "red" | "mega",
          sessionId: f.raceId,
          heatNumber: f.heatNumber,
        }).catch(() => null);
      }
    }
  } catch {
    /* the webhook's 200 never depends on this module */
  }
}
