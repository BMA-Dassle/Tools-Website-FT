import "server-only";

/**
 * Record a briefed session's final best laps — once — and serve them forever
 * after (well, 48h) from Redis.
 *
 * WHY RECORD AT ALL (owner 2026-08-11): "the leaderboard isn't always
 * available, so you have to find a way to grab those last best times." The
 * timing socket serves a finished heat's standings only until staff load the
 * NEXT heat; the welcome-back board needs them long after. So the first poll
 * that finds the window open captures the frame and persists it; every later
 * poll reads the record.
 *
 * THE HEAT-MATCH GATE: a capture is only recorded when the frame's own heat
 * number equals the assignment's. If the next heat is already loaded (or a
 * group event with an unparseable name is running) the capture returns null
 * and the board simply shows no names — recording a race we cannot prove is
 * ours would put the WRONG names on a wall.
 *
 * Names are stored exactly as the timing system displays them (owner: "use
 * the names directly from that leaderboard — doesn't need to relate back to
 * personId or anything"). No BMI ids ride through here, so plain JSON is safe.
 */
import redis from "@/lib/redis";
import { recordRaceLapResults } from "~/features/racing/data/race-lap-results-db";
import { readRaceBestLaps } from "~/features/racing/data/race-best-laps-db";
import { captureTrackResults } from "./results-capture.server";
import {
  driversFromBestLaps,
  driversFromScores,
  heatNameFromScores,
  type PandoraScoreRow,
} from "./results-fallback";
import type { ResultsDriver } from "./results-frame";
import type { TrackKey } from "../track";

/** Long enough to outlive any welcome-back window (they hold until the next
 *  briefing, which on a closing night is "until tomorrow"); short enough that
 *  Redis is not a lap-time archive. */
const RESULTS_TTL_SECONDS = 48 * 3600;

export interface RecordedResults {
  heatName: string;
  capturedAtMs: number;
  drivers: ResultsDriver[];
}

function resultsKey(sessionId: string): string {
  return `briefing:results:${sessionId}`;
}

/**
 * Read a race's stored standings WITHOUT attempting a capture.
 *
 * The results board walks back through the last few finished races looking for
 * one it can actually stand behind, and only the newest of them is plausibly
 * still on the timing wire. Capturing the older ones would open a socket per
 * race per poll to be told, correctly, that the frame is a different heat —
 * so those reads come through here instead.
 *
 * Null for "no record", an unreadable record, and a record with no drivers
 * alike: every caller treats all three the same way, and a board that cannot
 * name the racers must show nothing rather than an empty table.
 */
export async function readRecordedResults(sessionId: string): Promise<RecordedResults | null> {
  if (!sessionId) return null;
  try {
    const stored = await redis.get(resultsKey(sessionId));
    if (!stored) return null;
    const parsed = JSON.parse(stored) as RecordedResults;
    if (Array.isArray(parsed.drivers) && parsed.drivers.length > 0) return parsed;
  } catch {
    /* unreadable record reads as absent */
  }
  return null;
}

/** Kill switch for the non-wire standings sources (Pandora scores +
 *  race_best_laps). A merged feature is ON; this exists only to turn the
 *  fallback OFF in an emergency (owner rule 2026-07-31). */
function resultsFallbackEnabled(): boolean {
  return process.env.RESULTS_FALLBACK !== "false";
}

const PANDORA_HOST = "https://bma-pandora-api.azurewebsites.net";
const PANDORA_LOCATION = "LAB52GY480CJF";

/**
 * The session's OFFICIAL scores, straight from Pandora — positions, laps and
 * best times as the venue's record keeps them. Addressed by session id, so
 * unlike a wire frame it can never be a different heat's numbers.
 *
 * persId/parId are 17-digit BMI ids: they are stripped from the raw text
 * BEFORE JSON.parse so they can never round through a double (CLAUDE.md §
 * BMI ID Precision) — nothing on a wall wants them anyway.
 */
async function fetchPandoraScores(sessionId: string): Promise<PandoraScoreRow[] | null> {
  try {
    const res = await fetch(
      `${PANDORA_HOST}/v2/bmi/records/scores/${PANDORA_LOCATION}/${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const text = (await res.text()).replace(/"(persId|parId)"\s*:\s*(\d+)/g, '"$1":"$2"');
    const parsed = JSON.parse(text) as { data?: PandoraScoreRow[] };
    return Array.isArray(parsed?.data) && parsed.data.length > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function loadOrCaptureResults(args: {
  track: TrackKey;
  sessionId: string;
  heatNumber: number | null;
  /** The venue's stamped ActualEnd, when the caller has one. Its presence is
   *  what unlocks the fallback sources: during the pending-finish window karts
   *  are still completing their final lap, and folding standings then would
   *  freeze pre-final laps for 48h (review 2026-08-12). The wire capture needs
   *  no such gate — its frame carries its own finished state. */
  stampedEndMs?: number | null;
  /** What the record should be called if a fallback source has to supply it
   *  and Pandora's rows don't name the session. */
  heatName?: string | null;
  /** Set false to skip the wire grab — the results board's walk-back reads
   *  older races through here, and opening a socket per stale race per poll
   *  just gets told the frame is a different heat. Fallback sources are
   *  addressed by session id, so they still apply. */
  wire?: boolean;
}): Promise<RecordedResults | null> {
  if (!args.sessionId) return null;
  const key = resultsKey(args.sessionId);

  const stored = await readRecordedResults(args.sessionId);
  if (stored) return stored;

  const wantWire = args.wire !== false && args.heatNumber !== null;
  const wantFallback = resultsFallbackEnabled() && args.stampedEndMs != null;
  // Without a heat number the wire has no match gate (a capture would be a
  // guess), and without a stamped end the fallbacks may not run — nothing
  // left to try.
  if (!wantWire && !wantFallback) return null;

  // One recorder per tick: both room screens poll on the same 15s cadence, and
  // two simultaneous grabs of the same standings are waste. The loser's next
  // poll reads the winner's record.
  try {
    const claimed = await redis.set(`${key}:claim`, "1", "EX", 8, "NX");
    if (claimed !== "OK") return null;
  } catch {
    return null;
  }

  let record: RecordedResults | null = null;

  if (wantWire) {
    const frame = await captureTrackResults(args.track);
    // Heat match AND finished (state >= 3): a frame captured during the
    // pending-finish window still has karts completing their final lap, and a
    // best lap set on that final lap is ordinary — recording early would put a
    // qualifier under "didn't qualify" for 48h (review 2026-08-12). Recording
    // nothing here is safe: the next push or TV poll simply tries again.
    if (frame && frame.heatNumber === args.heatNumber && frame.state >= 3) {
      record = { heatName: frame.heatName, capturedAtMs: Date.now(), drivers: frame.drivers };
    }
  }

  /**
   * THE WIRE IS NOT THE ONLY WITNESS (2026-09-01: webserver22:10015 went dark
   * at 19:36 ET and heats 46-66 finished in front of an idle card). With a
   * STAMPED end in hand the standings are final, so two more sources apply,
   * in order of authority:
   *
   *   1. Pandora's scores — the official positions, the numbers the venue's
   *      own record keeps. Karts aren't in the payload; race_best_laps (folded
   *      live off the broadcast) supplies them by name.
   *   2. race_best_laps alone — ranked by best lap, the vendor's own ordering
   *      for an arrive-and-drive heat (proven identical to a real capture on
   *      heat 44, 2026-09-01). Survives even a full vendor-cloud outage.
   */
  if (!record && wantFallback) {
    const bestLaps = await readRaceBestLaps(args.sessionId).catch(() => []);
    const scores = await fetchPandoraScores(args.sessionId);
    if (scores) {
      const kartByName = new Map<string, string>();
      for (const row of bestLaps) {
        if (row.kart) kartByName.set(row.participantName, row.kart);
      }
      const drivers = driversFromScores(scores, kartByName);
      if (drivers.length > 0) {
        record = {
          heatName: heatNameFromScores(scores) ?? args.heatName ?? "",
          capturedAtMs: Date.now(),
          drivers,
        };
      }
    }
    if (!record && bestLaps.length > 0) {
      const drivers = driversFromBestLaps(bestLaps);
      if (drivers.length > 0) {
        record = { heatName: args.heatName ?? "", capturedAtMs: Date.now(), drivers };
      }
    }
  }

  if (!record) return null;

  try {
    await redis.set(key, JSON.stringify(record), "EX", RESULTS_TTL_SECONDS);
  } catch {
    /* served this once from memory; the next poll re-captures */
  }

  /**
   * THE SAME STANDINGS, KEPT (Neon) — see racing/data/race-lap-results-db.ts.
   *
   * Redis above stays the hot path and the 48h TTL stays exactly as it was: this
   * is an archive written underneath it, not a change to how any board reads.
   * It exists because the TTL is the right lifetime for a welcome-back wall and
   * the wrong one for "the fastest laps this week" — and because the POV overlay
   * loses a fifth of its cards to that same expiry.
   *
   * AFTER the Redis write and swallowed on failure, in that order and on
   * purpose: the boards must never lose their names to a Neon blip, and this
   * capture window does not come round again.
   */
  await recordRaceLapResults({
    sessionId: args.sessionId,
    heatName: record.heatName || args.heatName || null,
    heatNumber: args.heatNumber,
    track: args.track,
    capturedAtMs: record.capturedAtMs,
    drivers: record.drivers,
  }).catch((err) => console.error("[race-lap-results] archive write failed", err));

  return record;
}
