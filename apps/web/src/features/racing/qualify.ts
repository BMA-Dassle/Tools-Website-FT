/**
 * Racing level-up thresholds. PURE — no I/O, no clock.
 *
 * A racer moves Starter → Intermediate → Pro by lap time, and the cutoffs differ
 * per track because the tracks are not the same length. These numbers decide
 * whether a guest gets a "you levelled up" text, and now also whether their name
 * appears on the briefing-room board after their session — so they live in ONE
 * place that both readers import.
 *
 * They used to be four consts inside the level-up-watch cron. A second reader
 * copying them would be a slow-motion bug: the day somebody retunes a cutoff,
 * the text message and the wall would disagree about who qualified, in front of
 * the racer. Extracted rather than duplicated for exactly that reason.
 *
 * Source: the racing progression chart at the desk, and the public FAQ on
 * /racing (app/racing/layout.tsx — "41s Blue, 46s Red, or 1:28 Mega" /
 * "32.5s Blue, 37s Red, or 1:08.5 Mega").
 *   Starter → Intermediate  41.0s Blue / 46.0s Red / 1:28.0 Mega
 *   Intermediate → Pro      32.5s Blue / 37.0s Red / 1:08.5 Mega
 *
 * MEGA HAS CUTOFFS. An earlier version of this file returned null for Mega on
 * the theory that a combined-circuit lap "cannot be compared" — overturned
 * 2026-08-11 by the owner pointing at our own /racing page, which has published
 * Mega qualifying times all along (1:28 = 88 000 ms, 1:08.5 = 68 500 ms). The
 * cutoffs were sanity-checked against real Mega heats the same night: the Pro
 * grid ran 63.3–69.2s around the 68.5s line, a lower grid ran 82.9–90.5s
 * around the 88s line.
 */

/** The two levels an ADULT racer can qualify INTO. Starter needs no
 *  qualification. Juniors climb their own ladder — see the junior consts. */
export type QualifyLevel = "Intermediate" | "Pro";

/** What nextLevelTarget can point a grid at — the adult levels plus the junior
 *  ladder ("Junior Intermediate", "Junior Pro"), which has its own cutoffs. */
export type QualifyTargetLevel = QualifyLevel | "Junior Intermediate" | "Junior Pro";

export const QUALIFY_INTERMEDIATE_BLUE = 41_000;
export const QUALIFY_INTERMEDIATE_RED = 46_000;
/** 1:28.0 on the combined 2,108 ft circuit (public /racing FAQ). */
export const QUALIFY_INTERMEDIATE_MEGA = 88_000;
export const QUALIFY_PRO_BLUE = 32_500;
export const QUALIFY_PRO_RED = 37_000;
/** 1:08.5 on the combined circuit (public /racing FAQ). */
export const QUALIFY_PRO_MEGA = 68_500;

/**
 * The JUNIOR ladder (public /racing FAQ: "Junior Intermediate requires a 1:15
 * lap in Junior Starter, and Junior Pro requires a 45s lap in Junior
 * Intermediate"). One number each, not per-track: junior races run the split
 * tracks (Mega Tuesdays are Junior Pro only — no junior qualifying happens
 * there), and the page publishes a single time per step.
 */
export const QUALIFY_JUNIOR_INTERMEDIATE = 75_000;
export const QUALIFY_JUNIOR_PRO = 45_000;

/** The pair of cutoffs for however the upstream spelled the track. Anything
 *  neither recognisably Mega nor Blue is treated as Red, the conservative
 *  direction: Red's cutoffs are the slowest of the split tracks, so a
 *  mis-detected track can only ever under-award, never hand somebody a level
 *  they did not earn. Mega is matched FIRST — its laps are twice a split-track
 *  lap, and judging one against Red's cutoff would fail everybody. */
function cutoffsFor(track: string): { intermediate: number; pro: number } {
  const name = (track || "").toLowerCase();
  if (name.includes("mega")) {
    return { intermediate: QUALIFY_INTERMEDIATE_MEGA, pro: QUALIFY_PRO_MEGA };
  }
  if (name.includes("blue")) {
    return { intermediate: QUALIFY_INTERMEDIATE_BLUE, pro: QUALIFY_PRO_BLUE };
  }
  return { intermediate: QUALIFY_INTERMEDIATE_RED, pro: QUALIFY_PRO_RED };
}

/** What level this lap qualifies for, or null. `track` is matched loosely on
 *  purpose — callers hand in whatever the upstream called it ("Blue Track",
 *  "Blue Starter", "mega"). */
export function qualifiesFor(bestLapMs: number, track: string): QualifyLevel | null {
  if (!Number.isFinite(bestLapMs) || bestLapMs <= 0) return null;
  const cutoffs = cutoffsFor(track);
  if (bestLapMs <= cutoffs.pro) return "Pro";
  if (bestLapMs <= cutoffs.intermediate) return "Intermediate";
  return null;
}

/**
 * What lap they have to beat, in the race they are about to run, to earn the next
 * level — for the briefing-room board (owner 2026-08-11).
 *
 * Reads the SAME constants qualifiesFor does, so the target a racer is shown before
 * the race cannot disagree with the decision made after it.
 *
 * Null when there is nothing to aim for: a Pro session (adult or junior — the
 * top of either ladder) or a session type we do not recognise.
 *
 * JUNIOR RACES CLIMB THE JUNIOR LADDER: a Junior Starter grid is aiming at
 * Junior Intermediate (1:15), never at the adult cutoff for the same track —
 * junior karts are speed-limited and the adult line would be unreachable.
 * Matched BEFORE the adult branch because every junior race type also contains
 * the words "starter"/"intermediate"/"pro".
 */
export function nextLevelTarget(
  track: string,
  raceType: string | null | undefined,
): { level: QualifyTargetLevel; ms: number } | null {
  const rt = (raceType || "").toLowerCase();
  if (!rt || rt.includes("pro")) return null;
  if (rt.includes("junior")) {
    // NO JUNIOR TARGETS ON MEGA. The junior ladder's cutoffs are split-track
    // laps (1:15 / 45s) — on the 2,108 ft combined circuit they are physically
    // unreachable, and Mega runs Junior Pro only anyway (owner 2026-08-05), so
    // a junior Starter/Intermediate heat there is already off-policy. A wall
    // promising an impossible time is worse than one promising nothing.
    // Same loose name-match convention as cutoffsFor.
    if ((track || "").toLowerCase().includes("mega")) return null;
    if (rt.includes("intermediate")) {
      return { level: "Junior Pro", ms: QUALIFY_JUNIOR_PRO };
    }
    if (rt.includes("starter")) {
      return { level: "Junior Intermediate", ms: QUALIFY_JUNIOR_INTERMEDIATE };
    }
    return null;
  }
  const cutoffs = cutoffsFor(track);
  if (rt.includes("intermediate")) return { level: "Pro", ms: cutoffs.pro };
  if (rt.includes("starter")) return { level: "Intermediate", ms: cutoffs.intermediate };
  return null;
}

/** Lap time the way racers read it: "36.785" under a minute, "1:28.000" over —
 *  the same shape the live leaderboard renders, which matters now that Mega
 *  targets (88s, 68.5s) pass through here. */
export function formatLap(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const rest = ms - minutes * 60_000;
    return `${minutes}:${(rest / 1000).toFixed(3).padStart(6, "0")}`;
  }
  return (ms / 1000).toFixed(3);
}
