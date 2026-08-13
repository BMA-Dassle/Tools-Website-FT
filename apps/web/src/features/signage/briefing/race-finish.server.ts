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
import { extractRaceFinishes, isActionableFinish } from "~/features/racing/venue-broadcast";
import { recordRaceTiming } from "~/features/racing/data/race-timings-db";
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
