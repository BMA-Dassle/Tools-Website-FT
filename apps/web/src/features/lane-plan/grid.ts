/**
 * Lane arrangement — pure grid operations.
 *
 * No I/O. Everything here is a function of a `LaneGrid` snapshot, so it can be
 * unit-tested against fixtures captured from real days (a league blocking eight
 * lanes, a maintenance block, a session already running at window start).
 */
import { forecastPeak } from "./forecast";
import type { BusyInterval, LaneGrid } from "./types";

/** Lanes are physically paired odd-even — verified live: 98.5% of FM and 98.8% of Naples
 *  two-lane bookings land on a true pair rather than straddling two. The pair shares a
 *  ball return and settee, so it is the adjacency unit the owner's rule is about. */
export function pairOf(lane: number): number {
  return Math.ceil(lane / 2);
}

/** The other lane of this lane's pair. */
export function mateOf(lane: number): number {
  return lane % 2 === 1 ? lane + 1 : lane - 1;
}

/** True when the two lanes form a true pair (1-2, 3-4, …), not a straddle (2-3). */
export function isTruePair(a: number, b: number): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return hi - lo === 1 && lo % 2 === 1;
}

/** Half-open overlap: [aStart, aEnd) vs [bStart, bEnd). Touching does not overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Intervals that block a lane over the window.
 *
 * `ignoreReservationId` drops the reservation being re-placed, so the sweep can ask
 * "where else could this go?" without colliding with itself.
 */
export function blockingIntervals(
  grid: LaneGrid,
  lane: number,
  startMs: number,
  endMs: number,
  ignoreReservationId?: string,
): BusyInterval[] {
  return grid.busy.filter(
    (b) =>
      b.laneNumber === lane &&
      b.reservationId !== ignoreReservationId &&
      overlaps(startMs, endMs, b.startMs, b.endMs),
  );
}

/** Is this lane free for the whole window? `Error` lanes are never free. */
export function isLaneFree(
  grid: LaneGrid,
  lane: number,
  startMs: number,
  endMs: number,
  ignoreReservationId?: string,
): boolean {
  if (grid.errorLanes.has(lane)) return false;
  return blockingIntervals(grid, lane, startMs, endMs, ignoreReservationId).length === 0;
}

/** Every lane free for the whole window, ascending. */
export function freeLanes(
  grid: LaneGrid,
  startMs: number,
  endMs: number,
  ignoreReservationId?: string,
  allowed?: readonly number[] | null,
): number[] {
  const allowedSet = allowed && allowed.length ? new Set(allowed) : null;
  return grid.lanes.filter(
    (l) =>
      (!allowedSet || allowedSet.has(l)) &&
      isLaneFree(grid, l, startMs, endMs, ignoreReservationId),
  );
}

/** How many lanes are busy at one instant. */
export function occupancyAt(grid: LaneGrid, atMs: number, ignoreReservationId?: string): number {
  const busy = new Set<number>();
  for (const b of grid.busy) {
    if (b.reservationId === ignoreReservationId) continue;
    if (atMs >= b.startMs && atMs < b.endMs) busy.add(b.laneNumber);
  }
  return busy.size;
}

/**
 * Projected occupancy across a window, as a fraction of the house.
 *
 * This is the pressure signal the whole policy pivots on, and it is deliberately
 * forward-looking: at 2pm FM sits near 40% but by 8pm it is 96%, so a decision made
 * for a 6pm session must be scored against 6pm's board, not against right now.
 *
 * `peak` drives the backfill flip — one crowded 15 minutes inside the window is enough
 * to make spreading expensive, because the fresh pair we opened is still occupied then.
 *
 * The grid's own bookings are a FLOOR, not the answer. 76% of a Saturday is booked
 * same-day, so a board read at 2pm knows only a fraction of 8pm. Where a historical
 * forecast exists we take the greater of the two: what we can see cannot be wrong, and
 * what the day usually becomes covers what we cannot see yet.
 */
export function projectedOccupancy(
  grid: LaneGrid,
  startMs: number,
  endMs: number,
  ignoreReservationId?: string,
  bucketMinutes = 15,
): { mean: number; peak: number; observedPeak: number; forecastPeak: number | null } {
  const step = bucketMinutes * 60_000;
  const capacity = grid.lanes.length || 1;
  let total = 0;
  let peak = 0;
  let n = 0;
  for (let t = startMs; t < endMs; t += step) {
    const used = occupancyAt(grid, t, ignoreReservationId);
    total += used;
    if (used > peak) peak = used;
    n++;
  }
  const observedPeak = n === 0 ? 0 : peak / capacity;
  const observedMean = n === 0 ? 0 : total / n / capacity;
  const fc = forecastPeak(grid.forecast, startMs, endMs);
  return {
    mean: fc == null ? observedMean : Math.max(observedMean, fc),
    peak: fc == null ? observedPeak : Math.max(observedPeak, fc),
    observedPeak,
    forecastPeak: fc,
  };
}

/** Contiguous runs of free lanes over the window, as arrays of lane numbers. */
export function freeRuns(
  grid: LaneGrid,
  startMs: number,
  endMs: number,
  ignoreReservationId?: string,
  allowed?: readonly number[] | null,
): number[][] {
  const free = freeLanes(grid, startMs, endMs, ignoreReservationId, allowed);
  const runs: number[][] = [];
  let current: number[] = [];
  for (const lane of free) {
    if (current.length && lane === current[current.length - 1] + 1) current.push(lane);
    else {
      if (current.length) runs.push(current);
      current = [lane];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

/**
 * Pairs with BOTH lanes free over the window — the inventory a big party needs.
 *
 * This is the direct expression of "save the other 8 for bigger reservations": placing a
 * single on a fresh pair spends one of these, placing it alongside an existing booking
 * spends none.
 */
export function wholeFreePairs(
  grid: LaneGrid,
  startMs: number,
  endMs: number,
  ignoreReservationId?: string,
  allowed?: readonly number[] | null,
  occupiedExtra?: ReadonlySet<number>,
): number {
  const free = new Set(freeLanes(grid, startMs, endMs, ignoreReservationId, allowed));
  if (occupiedExtra) for (const l of occupiedExtra) free.delete(l);
  const seen = new Set<number>();
  let count = 0;
  for (const lane of free) {
    const p = pairOf(lane);
    if (seen.has(p)) continue;
    seen.add(p);
    if (free.has(mateOf(lane))) count++;
  }
  return count;
}

/**
 * A reservation can only be moved while it is still purely a booking.
 *
 * Once a lane is Open/Running the session is physically live and QAMF stops accepting
 * mutations; Completed/Canceled/NoShow are history. `Ready` means staff have already
 * set the lane up for that group, so leave it alone too.
 */
export function isMovable(intervals: readonly BusyInterval[], grid: LaneGrid): boolean {
  if (!intervals.length) return false;
  const FROZEN_LANE = new Set(["Running", "Completed", "Canceled", "Ready"]);
  const FROZEN_RES = new Set(["Completed", "Canceled", "NoShow", "Arrived"]);
  return intervals.every(
    (b) =>
      !FROZEN_LANE.has(b.laneStatus) &&
      !FROZEN_RES.has(b.reservationStatus) &&
      !b.isBlock &&
      !grid.openLanes.has(b.laneNumber),
  );
}

/** Group a grid's intervals by reservation id. */
export function byReservation(grid: LaneGrid): Map<string, BusyInterval[]> {
  const out = new Map<string, BusyInterval[]>();
  for (const b of grid.busy) {
    const list = out.get(b.reservationId);
    if (list) list.push(b);
    else out.set(b.reservationId, [b]);
  }
  for (const list of out.values()) list.sort((a, b) => a.laneNumber - b.laneNumber);
  return out;
}
