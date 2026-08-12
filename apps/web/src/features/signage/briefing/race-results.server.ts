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
import { captureTrackResults } from "./results-capture.server";
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

export async function loadOrCaptureResults(args: {
  track: TrackKey;
  sessionId: string;
  heatNumber: number | null;
}): Promise<RecordedResults | null> {
  if (!args.sessionId) return null;
  const key = `briefing:results:${args.sessionId}`;

  try {
    const stored = await redis.get(key);
    if (stored) {
      const parsed = JSON.parse(stored) as RecordedResults;
      if (Array.isArray(parsed.drivers) && parsed.drivers.length > 0) return parsed;
    }
  } catch {
    /* unreadable record → try a fresh capture below */
  }

  // Without a heat number there is no match gate, and without the gate a
  // capture is a guess. Skip — never record a guess.
  if (args.heatNumber === null) return null;

  // One capturer per tick: both room screens poll on the same 15s cadence, and
  // two simultaneous socket grabs of the same frame are waste. The loser's next
  // poll reads the winner's record.
  try {
    const claimed = await redis.set(`${key}:claim`, "1", "EX", 8, "NX");
    if (claimed !== "OK") return null;
  } catch {
    return null;
  }

  const frame = await captureTrackResults(args.track);
  // Heat match AND finished (state >= 3): a frame captured during the
  // pending-finish window still has karts completing their final lap, and a
  // best lap set on that final lap is ordinary — recording early would put a
  // qualifier under "didn't qualify" for 48h (review 2026-08-12). Recording
  // nothing here is safe: the next push or TV poll simply tries again.
  if (!frame || frame.heatNumber !== args.heatNumber || frame.state < 3) return null;

  const record: RecordedResults = {
    heatName: frame.heatName,
    capturedAtMs: Date.now(),
    drivers: frame.drivers,
  };
  try {
    await redis.set(key, JSON.stringify(record), "EX", RESULTS_TTL_SECONDS);
  } catch {
    /* served this once from memory; the next poll re-captures */
  }
  return record;
}
