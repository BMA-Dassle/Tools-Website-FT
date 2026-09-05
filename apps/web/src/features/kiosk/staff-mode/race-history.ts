/**
 * Race history — PURE shaping of Office `personStats/races` rows into what the
 * staff sheet shows: one line per heat, a best per track, and how far the
 * racer is from the next level on the track they are best on.
 *
 * Scores are lap MILLISECONDS. Track is matched loosely on `resourceName`
 * ("Blue Track" / "Red Track" / "Mega Track"), the same convention
 * racing/qualify.ts uses, so the distance-to-level line and the level-up text a
 * racer gets after a heat read one set of cutoffs.
 */
import { nextLevelTarget, qualifiesFor } from "~/features/racing/qualify";

export interface RaceHistoryRow {
  /** ISO local start ("2026-07-24T20:00:00"). */
  when: string;
  /** Venue heat name, e.g. "46 - Red Starter". */
  heat: string;
  track: string;
  kart: string;
  bestMs: number | null;
  avgMs: number | null;
  laps: number | null;
  position: number | null;
}

export type TrackKey = "blue" | "red" | "mega";

export interface RaceHistorySummary {
  races: number;
  /** Fastest lap per track, ms. */
  best: Partial<Record<TrackKey, number>>;
  /** The level their best laps already earn, per track (null = Starter pace). */
  earned: Partial<Record<TrackKey, "Intermediate" | "Pro" | null>>;
  /** Closest climb: the track where the gap to the next adult level is
   *  smallest, with the target. Null when every track is already at Pro pace
   *  or there are no timed laps. */
  next: { track: TrackKey; level: string; targetMs: number; gapMs: number } | null;
  first: string | null;
  last: string | null;
}

export function trackKeyOf(name: string | null | undefined): TrackKey | null {
  const n = (name || "").toLowerCase();
  if (n.includes("mega")) return "mega";
  if (n.includes("blue")) return "blue";
  if (n.includes("red")) return "red";
  return null;
}

/** Office rows → rows for the table, newest first, junk dropped. */
export function shapeRaceHistory(
  rows: ReadonlyArray<{
    scheduledStart?: string;
    resourceName?: string;
    sessionName?: string;
    kart?: string;
    finishPosition?: number | null;
    bestScore?: number | null;
    avgScore?: number | null;
    scoreLaps?: number | null;
  }>,
): RaceHistoryRow[] {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return rows
    .filter((r) => typeof r?.scheduledStart === "string")
    .map((r) => ({
      when: r.scheduledStart as string,
      heat: String(r.sessionName ?? "").trim() || "Heat",
      track: String(r.resourceName ?? "").trim() || "—",
      kart: String(r.kart ?? "").trim(),
      bestMs: num(r.bestScore),
      avgMs: num(r.avgScore),
      laps: num(r.scoreLaps),
      position: num(r.finishPosition),
    }))
    .sort((a, b) => b.when.localeCompare(a.when));
}

export function summarizeRaceHistory(rows: readonly RaceHistoryRow[]): RaceHistorySummary {
  const best: Partial<Record<TrackKey, number>> = {};
  for (const r of rows) {
    const k = trackKeyOf(r.track);
    if (!k || r.bestMs == null) continue;
    if (best[k] == null || r.bestMs < best[k]!) best[k] = r.bestMs;
  }
  const earned: RaceHistorySummary["earned"] = {};
  let next: RaceHistorySummary["next"] = null;
  for (const k of Object.keys(best) as TrackKey[]) {
    const ms = best[k]!;
    const level = qualifiesFor(ms, k);
    earned[k] = level;
    // The adult ladder: Starter pace aims at Intermediate, Intermediate at Pro.
    const target = nextLevelTarget(k, level === "Intermediate" ? "intermediate" : "starter");
    if (!target) continue;
    const gap = ms - target.ms;
    if (gap <= 0) continue; // already there — qualifiesFor would have said so
    if (!next || gap < next.gapMs)
      next = { track: k, level: target.level, targetMs: target.ms, gapMs: gap };
  }
  return {
    races: rows.length,
    best,
    earned,
    next,
    first: rows.length ? rows[rows.length - 1].when : null,
    last: rows.length ? rows[0].when : null,
  };
}

/** Lap time as racers read it — "44.233" under a minute, "1:24.208" over. */
export function formatLapMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}:${((ms - m * 60_000) / 1000).toFixed(3).padStart(6, "0")}`;
  }
  return (ms / 1000).toFixed(3);
}

/** Gap the way the briefing board says it: "1.31 s off Pro". */
export function formatGapMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}
