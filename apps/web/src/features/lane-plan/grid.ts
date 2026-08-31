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

/**
 * How snugly a window sits inside a lane's free time — the TIME dimension of packing.
 *
 * WHAT THIS IS NOT. It does not recover "lost lane-hours". Which lane a booking sits on is
 * a permutation: if ten groups are bowling at 8pm then eighteen lanes are free at 8pm, no
 * matter how they are arranged. Capacity at an instant cannot be improved by moving anyone.
 *
 * WHAT IT IS. A guest wanting two hours needs ONE lane clear for the whole two hours.
 * Scatter bookings across every lane and the house can be a third empty while unable to
 * sell a single long session. Measured at FM (`duration-fragmentation.mts`): on 2026-08-15
 * at 17:00, **13 lanes were free and none could host even 90 minutes**; 2026-08-08 ran the
 * same way from 15:00 to 18:00. So the goal is to keep some lanes clear for long stretches
 * — the same argument as saving whole pairs for big parties, in the time axis.
 *
 * Consolidating bookings only helps where they are SCATTERED. If every lane is genuinely
 * back-to-back the demand has filled the house and no arrangement changes that.
 *
 * Returns the dead time left on each side, in minutes. `null` means open-ended — no
 * booking bounds that side within the grid's window.
 */
export function gapFit(
  grid: LaneGrid,
  lane: number,
  startMs: number,
  endMs: number,
  ignoreReservationId?: string,
): { before: number | null; after: number | null } {
  let prevEnd = -Infinity;
  let nextStart = Infinity;
  for (const b of grid.busy) {
    if (b.laneNumber !== lane || b.reservationId === ignoreReservationId) continue;
    if (b.endMs <= startMs && b.endMs > prevEnd) prevEnd = b.endMs;
    if (b.startMs >= endMs && b.startMs < nextStart) nextStart = b.startMs;
  }
  return {
    before: prevEnd === -Infinity ? null : Math.round((startMs - prevEnd) / 60_000),
    after: nextStart === Infinity ? null : Math.round((nextStart - endMs) / 60_000),
  };
}

/**
 * Gaps a placement would leave that are too short to sell to anybody.
 *
 * A zero gap is ideal — the booking butts straight onto its neighbour, wasting nothing. A
 * gap at or above the shortest sellable session is fine, someone can still book it.
 * Anything between is a hole no product fits into.
 *
 * `minSellableMinutes` is per-center and must come from the catalogue, not a constant:
 * HeadPinz's shortest open-play option is 60 minutes (options 1226/1258) while FastTrax
 * duckpin genuinely sells 30 (option 33), so a single global floor would either strand
 * FastTrax inventory or fail to protect HeadPinz.
 */
export function slivers(
  fit: { before: number | null; after: number | null },
  minSellableMinutes: number,
): number[] {
  const out: number[] = [];
  for (const gap of [fit.before, fit.after]) {
    if (gap == null) continue;
    if (gap > 0 && gap < minSellableMinutes) out.push(gap);
  }
  return out;
}

/**
 * How many lanes could host a session of `minutes` starting at `atMs`.
 *
 * This is the number the time-packing policy actually exists to raise, and it is the one to
 * judge any rearrangement by — not lane count, which a permutation cannot change. Pair it
 * with plain free-lane count: when the two diverge, long sessions are being refused while
 * the house sits half empty.
 */
export function lanesAvailableFor(
  grid: LaneGrid,
  atMs: number,
  minutes: number,
  allowed?: readonly number[] | null,
): number {
  const endMs = atMs + minutes * 60_000;
  return freeLanes(grid, atMs, endMs, undefined, allowed).length;
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
      !runningOnThisLane(grid, b.laneNumber, b.reservationId),
  );
}

/**
 * Is the lane physically open because of THIS booking?
 *
 * "The lane is open" and "this booking is the one on it" are different facts, and treating
 * them as one froze the exact bookings that most need moving: a guest due at 6:15 whose
 * lane is still running the 5pm group is not running anything — they are about to be walked
 * onto somebody else's lane. That is a repair, not a session in progress.
 *
 * Conservative when the floor cannot say: an Open lane we have no detail for is treated as
 * this booking's and left alone. A lane open with NO reservation behind it is a walk-in
 * Conqueror opened, which is definitively somebody else.
 */
function runningOnThisLane(grid: LaneGrid, lane: number, reservationId: string): boolean {
  if (!grid.openLanes.has(lane)) return false;
  const live = grid.liveLanes.find((l) => l.laneNumber === lane);
  if (!live) return true;
  if (live.reservationId == null) return false;
  return live.reservationId === reservationId;
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
