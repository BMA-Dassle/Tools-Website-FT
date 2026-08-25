/**
 * Lane arrangement — the walk-in forecast.
 *
 * WHY THIS EXISTS. The spread/backfill decision pivots on how full the house will be
 * during the session being placed. Counting only the bookings already on the board
 * systematically under-estimates that, because 76% of a Saturday arrives same-day —
 * 27.6% at 1-4h lead, 19.2% under an hour, 13.8% pure walk-up. Score a 6pm booking at 2pm
 * against the 2pm board and it looks quiet, so the engine spreads into a fresh pair that is
 * still occupied at 8pm when the house is at 96% and a big group is being turned away.
 *
 * A backtest without this made exactly that mistake: pinning at create dropped crowding
 * from 84.3% to 73.0% but took whole free pairs at peak from 2 to 0. Spreading early is
 * only free if the day stays quiet.
 *
 * So pressure = max(what we can see, what this day historically becomes).
 */
import type { Reservation } from "@/lib/qamf-bowling";

/** 15-minute buckets from 09:00 ET, covering a 09:00 -> 02:00 operating day. */
export const BUCKET_MINUTES = 15;
export const DAY_START_HOUR = 9;
export const BUCKETS_PER_DAY = ((26 - DAY_START_HOUR) * 60) / BUCKET_MINUTES;

export interface OccupancyForecast {
  /** day-of-week (0 = Sunday) -> per-bucket mean occupancy, as a fraction of the house. */
  byDow: Map<number, number[]>;
  laneCount: number;
  /** How many distinct dates fed each day-of-week. Thin samples make a weak forecast. */
  daysPerDow: Map<number, number>;
}

const etParts = (ms: number) => {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dowMap[g("weekday")] ?? 0,
    hour: Number(g("hour")),
    minute: Number(g("minute")),
    date: `${g("year")}-${g("month")}-${g("day")}`,
  };
};

/**
 * Bucket index within the operating day, or -1 if outside it.
 *
 * Hours after midnight belong to the PREVIOUS operating day — a 1am Saturday-night session
 * is Saturday's business, not Sunday's — so they extend past bucket 60 rather than wrapping.
 */
export function bucketOf(ms: number): { dow: number; bucket: number } {
  const { dow, hour, minute } = etParts(ms);
  const postMidnight = hour < DAY_START_HOUR;
  const h = postMidnight ? hour + 24 : hour;
  const bucket = Math.floor(((h - DAY_START_HOUR) * 60 + minute) / BUCKET_MINUTES);
  const owningDow = postMidnight ? (dow + 6) % 7 : dow;
  if (bucket < 0 || bucket >= BUCKETS_PER_DAY) return { dow: owningDow, bucket: -1 };
  return { dow: owningDow, bucket };
}

/**
 * Learn expected occupancy per weekday and time-of-day from real history.
 *
 * Counts every lane-hour that was ever occupied, including front-desk walk-ins, leagues and
 * maintenance — the house being physically full is what matters, not who filled it.
 */
export function buildOccupancyForecast(
  reservations: readonly Reservation[],
  laneCount: number,
): OccupancyForecast {
  // dow -> bucket -> set of lanes busy, per date, so we can average across dates.
  const perDate = new Map<string, { dow: number; buckets: Array<Set<number>> }>();

  for (const r of reservations) {
    if (r.Status === "Canceled" || r.Status === "NoShow") continue;
    for (const lane of r.Lanes ?? []) {
      const start = Date.parse(lane.StartTime);
      const end = Date.parse(lane.EndTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      for (let t = start; t < end; t += BUCKET_MINUTES * 60_000) {
        const { dow, bucket } = bucketOf(t);
        if (bucket < 0) continue;
        // Key by the operating date so two Saturdays average rather than sum.
        const { date } = etParts(t - (etParts(t).hour < DAY_START_HOUR ? 12 * 3600_000 : 0));
        let entry = perDate.get(date);
        if (!entry) {
          entry = {
            dow,
            buckets: Array.from({ length: BUCKETS_PER_DAY }, () => new Set<number>()),
          };
          perDate.set(date, entry);
        }
        entry.buckets[bucket].add(lane.LaneNumber);
      }
    }
  }

  const totals = new Map<number, number[]>();
  const daysPerDow = new Map<number, number>();
  for (const { dow, buckets } of perDate.values()) {
    let acc = totals.get(dow);
    if (!acc) {
      acc = new Array(BUCKETS_PER_DAY).fill(0);
      totals.set(dow, acc);
    }
    for (let b = 0; b < BUCKETS_PER_DAY; b++) acc[b] += buckets[b].size;
    daysPerDow.set(dow, (daysPerDow.get(dow) ?? 0) + 1);
  }

  const byDow = new Map<number, number[]>();
  for (const [dow, acc] of totals) {
    const days = daysPerDow.get(dow) ?? 1;
    byDow.set(
      dow,
      acc.map((sum) => sum / days / Math.max(1, laneCount)),
    );
  }
  return { byDow, laneCount, daysPerDow };
}

/** Below this many observed dates for a weekday, the forecast is too thin to steer on. */
export const MIN_DAYS_PER_DOW = 3;

/** Expected occupancy fraction at an instant, or `null` when we have no basis. */
export function forecastAt(f: OccupancyForecast | null | undefined, atMs: number): number | null {
  if (!f) return null;
  const { dow, bucket } = bucketOf(atMs);
  if (bucket < 0) return null;
  if ((f.daysPerDow.get(dow) ?? 0) < MIN_DAYS_PER_DOW) return null;
  return f.byDow.get(dow)?.[bucket] ?? null;
}

/** Peak expected occupancy across a window, or `null` when we have no basis. */
export function forecastPeak(
  f: OccupancyForecast | null | undefined,
  startMs: number,
  endMs: number,
): number | null {
  if (!f) return null;
  let peak: number | null = null;
  for (let t = startMs; t < endMs; t += BUCKET_MINUTES * 60_000) {
    const v = forecastAt(f, t);
    if (v == null) continue;
    if (peak == null || v > peak) peak = v;
  }
  return peak;
}
