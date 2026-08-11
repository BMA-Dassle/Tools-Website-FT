/**
 * Racing level-up thresholds. PURE — no I/O, no clock.
 *
 * A racer moves Starter → Intermediate → Pro by lap time, and the cutoffs differ
 * per track because Blue and Red are not the same length. These numbers decide
 * whether a guest gets a "you levelled up" text, and now also whether their name
 * appears on the briefing-room board after their session — so they live in ONE
 * place that both readers import.
 *
 * They used to be four consts inside the level-up-watch cron. A second reader
 * copying them would be a slow-motion bug: the day somebody retunes a cutoff,
 * the text message and the wall would disagree about who qualified, in front of
 * the racer. Extracted rather than duplicated for exactly that reason.
 *
 * Source: the racing progression chart at the desk.
 *   Starter → Intermediate  41.0s Blue / 46.0s Red
 *   Intermediate → Pro      32.5s Blue / 37.0s Red
 */

/** The two levels a racer can qualify INTO. Starter needs no qualification. */
export type QualifyLevel = "Intermediate" | "Pro";

export const QUALIFY_INTERMEDIATE_BLUE = 41_000;
export const QUALIFY_INTERMEDIATE_RED = 46_000;
export const QUALIFY_PRO_BLUE = 32_500;
export const QUALIFY_PRO_RED = 37_000;

/**
 * What level this lap qualifies for, or null.
 *
 * `track` is matched loosely on purpose — callers hand in whatever the upstream
 * called it ("Blue Track", "Blue Starter", "blue"). Anything that is not
 * recognisably Blue is treated as Red, which is the conservative direction: Red's
 * cutoffs are slower, so a mis-detected track can only ever under-award, never
 * hand somebody a level they did not earn.
 *
 * MEGA: a Mega lap is a lap of the combined 2,108 ft circuit and cannot be
 * compared against either track's cutoff, so it qualifies for nothing. Returning
 * null is right — the alternative is measuring a racer against a distance they
 * did not drive.
 */
export function qualifiesFor(bestLapMs: number, track: string): QualifyLevel | null {
  if (!Number.isFinite(bestLapMs) || bestLapMs <= 0) return null;
  const name = (track || "").toLowerCase();
  if (name.includes("mega")) return null;
  const isBlue = name.includes("blue");
  const proCutoff = isBlue ? QUALIFY_PRO_BLUE : QUALIFY_PRO_RED;
  const intermediateCutoff = isBlue ? QUALIFY_INTERMEDIATE_BLUE : QUALIFY_INTERMEDIATE_RED;
  if (bestLapMs <= proCutoff) return "Pro";
  if (bestLapMs <= intermediateCutoff) return "Intermediate";
  return null;
}

/**
 * What lap they have to beat, in the race they are about to run, to earn the next
 * level — for the briefing-room board (owner 2026-08-11).
 *
 * Reads the SAME constants qualifiesFor does, so the target a racer is shown before
 * the race cannot disagree with the decision made after it.
 *
 * Null when there is nothing to aim for: a Pro session (top level), a Mega session
 * (the combined circuit has no cutoffs — its laps are not comparable to either
 * track's), or a session type we do not recognise.
 */
export function nextLevelTarget(
  track: string,
  raceType: string | null | undefined,
): { level: QualifyLevel; ms: number } | null {
  const t = (track || "").toLowerCase();
  if (t.includes("mega")) return null;
  const isBlue = t.includes("blue");
  const rt = (raceType || "").toLowerCase();
  if (!rt || rt.includes("pro")) return null;
  if (rt.includes("intermediate")) {
    return { level: "Pro", ms: isBlue ? QUALIFY_PRO_BLUE : QUALIFY_PRO_RED };
  }
  if (rt.includes("starter")) {
    return {
      level: "Intermediate",
      ms: isBlue ? QUALIFY_INTERMEDIATE_BLUE : QUALIFY_INTERMEDIATE_RED,
    };
  }
  return null;
}

/** Lap time in seconds, three decimals — "36.785". */
export function formatLap(ms: number): string {
  return (ms / 1000).toFixed(3);
}
