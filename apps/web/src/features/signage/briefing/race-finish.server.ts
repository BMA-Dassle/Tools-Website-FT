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
 *   2. captures the final standings off the timing cloud socket AT THE FINISH
 *      MOMENT — the one instant the frame is guaranteed to still be serving
 *      this heat, which retires the "grab it before the next heat loads"
 *      gamble (the venue broadcast itself carries rosters but NO lap times —
 *      LapCount never fills in; surveyed 2026-08-12),
 *   3. fires the "{heat} returning to {room}" radio call if this race was
 *      briefed in one of our rooms.
 *
 * EVERY LAYER BELOW STILL STANDS. The Pandora actualEnd path keeps working
 * untouched, so a bridge outage (the pipe had a 2.5h hole on 8/11) degrades to
 * exactly the behaviour shipped yesterday — never worse, only slower.
 *
 * Never throws: this rides an ingest webhook whose 200 must not depend on us.
 */
import redis from "@/lib/redis";
import { businessDayYmdET } from "@/lib/race-business-day";
import { extractRaceFinishes, isActionableFinish } from "~/features/racing/venue-broadcast";
import { listBriefingAssignments } from "./assignments-db";
import { announceReturnOnce } from "./return-announce.server";
import { loadOrCaptureResults } from "./race-results.server";

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
 * Act on one webhook message. The broadcast re-sends the whole day's race list
 * on every state change and replays it in reconnect catch-up dumps, so this is
 * gated three deep: the freshness rule (pure, tested), a per-race NX claim,
 * and the announcer's own per-(room,session) claim underneath.
 */
export async function handleVenueMessage(message: unknown): Promise<void> {
  try {
    const finishes = extractRaceFinishes(message);
    if (finishes.length === 0) return;
    const nowMs = Date.now();

    for (const f of finishes) {
      if (!isActionableFinish(f, nowMs)) continue;

      // The marker is idempotent — write it before claiming so a crash between
      // the two can only cost the side-effects (which Pandora fallback and the
      // next poll's capture retry both cover), never the fast end signal.
      const marker: RaceFinishedMarker = {
        endedAtMs: f.actualEndMs ?? nowMs,
        heatNumber: f.heatNumber,
        heatName: f.heatName,
        track: f.track,
      };
      await redis
        .set(raceFinishedKey(f.raceId), JSON.stringify(marker), "EX", MARKER_TTL_SECONDS)
        .catch(() => void 0);

      // One handler per race: the same finish arrives in every subsequent
      // race-list push all night.
      const claimed = await redis
        .set(`briefing:finish-handled:${f.raceId}`, "1", "EX", 24 * 3600, "NX")
        .catch(() => null);
      if (claimed !== "OK") continue;

      // Final standings, at the moment they are guaranteed to be on the wire.
      if (f.track !== null && f.heatNumber !== null) {
        await loadOrCaptureResults({
          track: f.track as "blue" | "red" | "mega",
          sessionId: f.raceId,
          heatNumber: f.heatNumber,
        }).catch(() => null);
      }

      // Radio, only for races we briefed. Once-only is the announcer's claim.
      const assignments = await listBriefingAssignments("FT", businessDayYmdET()).catch(() => []);
      const briefed = assignments.find((a) => a.sessionId === f.raceId && a.mode === "timeline");
      if (briefed) {
        await announceReturnOnce({
          room: briefed.room,
          sessionId: briefed.sessionId,
          heatNumber: briefed.heatNumber,
        });
      }
    }
  } catch {
    /* the webhook's 200 never depends on this module */
  }
}
