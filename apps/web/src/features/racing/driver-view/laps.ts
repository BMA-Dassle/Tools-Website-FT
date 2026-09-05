/**
 * Lap arithmetic — everything the driver view says about a set of laps.
 *
 * PURE, so the numbers on the pit board can be tested without Redis, Neon, a
 * socket or a running race. The venue gives us raw crossings; every comparison
 * a driver actually cares about is derived here.
 *
 * ROLLOUT LAPS ARE REAL. The first crossings of a heat arrive with no
 * `LapTimeMs` at all — kart 15's heat 65 had two of them before its first timed
 * lap. They are kept, numbered, and excluded from every statistic. Dropping them
 * would renumber the laps and disagree with the venue; treating their absent
 * time as zero would hand the driver a 0.000 personal best.
 */
import type { DriverLap } from "./types";

export interface LapSummary {
  laps: DriverLap[];
  /** Laps with a time, in order. */
  timed: DriverLap[];
  /** Fastest timed lap, or null before the first one lands. */
  best: DriverLap | null;
  /** Slowest timed lap — the one worth labelling on a chart. */
  worst: DriverLap | null;
  /** Most recent lap that has a time. */
  last: DriverLap | null;
  /** Mean of the timed laps, ms. Null with nothing to average. */
  averageMs: number | null;
  /** Total crossings, rollout included — matches the venue's lap count. */
  count: number;
}

export function summarise(laps: readonly DriverLap[]): LapSummary {
  const ordered = [...laps].sort((a, b) => a.lapNumber - b.lapNumber);
  const timed = ordered.filter((l): l is DriverLap & { lapTimeMs: number } => l.lapTimeMs !== null);
  let best: DriverLap | null = null;
  let worst: DriverLap | null = null;
  let total = 0;
  for (const l of timed) {
    total += l.lapTimeMs as number;
    if (best === null || (l.lapTimeMs as number) < (best.lapTimeMs as number)) best = l;
    if (worst === null || (l.lapTimeMs as number) > (worst.lapTimeMs as number)) worst = l;
  }
  return {
    laps: ordered,
    timed,
    best,
    worst,
    last: timed.length > 0 ? timed[timed.length - 1] : null,
    averageMs: timed.length > 0 ? Math.round(total / timed.length) : null,
    count: ordered.length,
  };
}

/**
 * Is this lap a new personal best for the session?
 *
 * Asked at the moment a lap lands, against the laps that came BEFORE it — which
 * is why it takes a prior list rather than reading a summary that already
 * includes the new lap. A first timed lap is a best by definition, and the alert
 * for it is suppressed by the caller: telling someone their only lap is their
 * fastest is noise.
 */
export function isPersonalBest(priorLaps: readonly DriverLap[], lapTimeMs: number | null): boolean {
  if (lapTimeMs === null || lapTimeMs <= 0) return false;
  const priorBest = summarise(priorLaps).best;
  if (priorBest === null) return false;
  return lapTimeMs < (priorBest.lapTimeMs as number);
}

/** "1:06.832" from 66832, "31.208" under a minute — the venue's own format. */
export function formatLapTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

/** "+2.673" against the best, "" for the best lap itself. */
export function formatDelta(lapTimeMs: number | null, bestMs: number | null): string {
  if (lapTimeMs === null || bestMs === null) return "";
  const d = lapTimeMs - bestMs;
  if (d === 0) return "";
  return `${d > 0 ? "+" : "−"}${(Math.abs(d) / 1000).toFixed(3)}`;
}

/**
 * Turn crossings into numbered laps.
 *
 * The venue does not number them — it emits one passing per crossing — so the
 * order is ours to establish, and it is established by `PassingTimeUtc`, never
 * by arrival. The bridge forwards serially but a reconnect replays a whole day
 * out of order, and lap 3 landing after lap 9 must not renumber the heat.
 */
export function numberLaps(
  crossings: readonly { passingId: string; lapTimeMs: number | null; atUtc: string | null }[],
): DriverLap[] {
  return [...crossings]
    .filter((c) => c.atUtc !== null)
    .sort((a, b) => {
      const t = Date.parse(a.atUtc as string) - Date.parse(b.atUtc as string);
      return t !== 0 ? t : a.passingId.localeCompare(b.passingId);
    })
    .map((c, i) => ({
      lapNumber: i + 1,
      lapTimeMs: c.lapTimeMs,
      atUtc: c.atUtc as string,
      passingId: c.passingId,
    }));
}
