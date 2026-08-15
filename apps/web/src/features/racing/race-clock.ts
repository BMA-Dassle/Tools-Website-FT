/**
 * The race countdown — derived, because the venue's own field is dead.
 *
 * WHY THIS EXISTS (2026-08-15, measured against the live venue all night):
 * the timing server DOES publish a `TimeLeftMs` on its `BcFormat: "1"` stats
 * payload, and it reads **`0` on every frame of every race** — through a
 * resume, through a six-minute staff time-add, while the desk in front of the
 * owner counted down normally. It is not a client bug and not a stale
 * snapshot: `DurationTimeMs` in the same frame updates within a second of a
 * desk action. One field is simply not reporting. So we compute the clock
 * ourselves from the lifecycle records the bridge already receives, and we do
 * NOT subscribe to the stats payload at all (a second `BcStart` re-points the
 * feed globally — see the bridge README).
 *
 * THE FORMULA:
 *
 *     remaining = actualStart + duration + accumulatedPause − now
 *
 * Every term is load-bearing and each was learned the hard way:
 *
 *  - `actualStart` NEVER RESTAMPS ON RESUME. Race 58698117 was started at
 *    00:46:01, paused, resumed at ~00:57, and still reported `ActualStart
 *    00:46:01` an hour later. Deriving from start + duration alone claimed the
 *    race had ended 7 minutes before it actually did.
 *  - `duration` MOVES. Staff extend a race at the desk and the venue reports
 *    the new total here, not a delta (watched 40:00 → 46:00 → 53:00). Always
 *    read the latest value; never cache the one seen at start.
 *  - `accumulatedPause` is the whole reason the naive version fails. Verified
 *    exactly: race 58698117 ran a 62:23 wall span against a 53:00 duration,
 *    giving 9:23 of pause — against 9:39 fitted from two readings of the desk
 *    clock, i.e. the model is right to within how fast a human reads a screen.
 *
 * PURE. State transitions are reducers over a plain object so they can be
 * tested without Redis and without a running race at 2 AM; the Redis-backed
 * driver lives in race-clock.server.ts.
 */
import type { TrackKey } from "~/features/signage/track";
import {
  extractDurationChanges,
  extractRaceFinishes,
  extractRaceStarts,
  extractRaceStops,
  type VenueRaceFinish,
  type VenueDurationChange,
} from "./venue-broadcast";

export type RaceClockPhase = "running" | "paused" | "finished";

export interface RaceClockState {
  raceId: string;
  heatName: string;
  heatNumber: number | null;
  track: TrackKey | null;
  phase: RaceClockPhase;
  /** Venue-local start, epoch ms. Never restamped by the venue on resume. */
  actualStartMs: number | null;
  /** Latest configured length. Changes when staff add time. */
  durationMs: number | null;
  /** Pause time banked from COMPLETED pause intervals. */
  pausedTotalMs: number;
  /** When the current pause began (arrival-stamped), or null if running. */
  pausedSinceMs: number | null;
  actualEndMs: number | null;
  updatedAtMs: number;
}

export function emptyClock(raceId: string, nowMs: number): RaceClockState {
  return {
    raceId,
    heatName: "",
    heatNumber: null,
    track: null,
    phase: "running",
    actualStartMs: null,
    durationMs: null,
    pausedTotalMs: 0,
    pausedSinceMs: null,
    actualEndMs: null,
    updatedAtMs: nowMs,
  };
}

/**
 * Milliseconds left, or null when the record is too incomplete to say.
 *
 * Returning null rather than 0 for "we don't know" is deliberate: a board that
 * cannot tell "no time left" from "no data" will confidently show 00:00 for a
 * race that has barely started, which is exactly the failure the venue's own
 * `TimeLeftMs` exhibits.
 *
 * While PAUSED the clock freezes — the in-progress pause is added to the banked
 * total, so `now` advancing is cancelled out exactly.
 */
export function remainingMs(clock: RaceClockState, nowMs: number): number | null {
  if (clock.phase === "finished") return 0;
  if (clock.actualStartMs === null || clock.durationMs === null) return null;
  const openPause = clock.pausedSinceMs === null ? 0 : nowMs - clock.pausedSinceMs;
  return clock.actualStartMs + clock.durationMs + clock.pausedTotalMs + openPause - nowMs;
}

/** Never-negative remaining, for display. Kept separate from `remainingMs` so
 *  callers that need to know a race has RUN OVER (ops views) still can. */
export function displayRemainingMs(clock: RaceClockState, nowMs: number): number | null {
  const raw = remainingMs(clock, nowMs);
  return raw === null ? null : Math.max(0, raw);
}

/** "7:04". Negative renders as "-0:12" so an overrun is visible, not hidden. */
export function formatClock(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const total = Math.floor(Math.abs(ms) / 1000);
  return `${sign}${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A finished race's TRUE accumulated pause, measured rather than accrued.
 *
 * `(actualEnd − actualStart) − duration`. Independent of whether we were
 * connected for the pauses, so it is both a backfill for races we missed and
 * the check on our own accrual — the two agreed to 16s on the first race we
 * validated against.
 */
export function measuredPauseMs(f: {
  actualStartMs: number | null;
  actualEndMs: number | null;
  durationMs: number | null;
}): number | null {
  if (f.actualStartMs === null || f.actualEndMs === null || f.durationMs === null) return null;
  return Math.max(0, f.actualEndMs - f.actualStartMs - f.durationMs);
}

function withIdentity(clock: RaceClockState, rec: VenueRaceFinish): RaceClockState {
  return {
    ...clock,
    heatName: rec.heatName || clock.heatName,
    heatNumber: rec.heatNumber ?? clock.heatNumber,
    track: rec.track ?? clock.track,
  };
}

/**
 * A `RaceStart` arrived.
 *
 * This is both the green flag AND the resume — the venue sends the same record
 * for both, distinguished only by whether we already had the race paused. So a
 * resume closes the open pause interval and banks it; a first start just sets
 * the baseline. Duration is re-read every time, because a start that follows a
 * time-add carries the new total.
 */
export function applyRaceStart(
  clock: RaceClockState,
  rec: VenueRaceFinish,
  atMs: number,
): RaceClockState {
  const next = withIdentity(clock, rec);
  const banked =
    clock.pausedSinceMs === null
      ? clock.pausedTotalMs
      : clock.pausedTotalMs + Math.max(0, atMs - clock.pausedSinceMs);
  return {
    ...next,
    phase: "running",
    actualStartMs: rec.actualStartMs ?? clock.actualStartMs,
    durationMs: rec.durationMs ?? clock.durationMs,
    pausedTotalMs: banked,
    pausedSinceMs: null,
    updatedAtMs: atMs,
  };
}

/**
 * A `RaceStop` arrived — the race is paused.
 *
 * Stamped with ARRIVAL time, not a venue timestamp, because the record does not
 * carry one. Re-entrant: a repeated RaceStop (the snapshot resends constantly)
 * must not restart the pause window, or a long pause would keep collapsing to
 * nothing.
 */
export function applyRaceStop(
  clock: RaceClockState,
  rec: VenueRaceFinish,
  atMs: number,
): RaceClockState {
  const next = withIdentity(clock, rec);
  if (clock.pausedSinceMs !== null && clock.phase === "paused") {
    return { ...next, durationMs: rec.durationMs ?? clock.durationMs };
  }
  return {
    ...next,
    phase: "paused",
    actualStartMs: rec.actualStartMs ?? clock.actualStartMs,
    durationMs: rec.durationMs ?? clock.durationMs,
    pausedSinceMs: atMs,
    updatedAtMs: atMs,
  };
}

/** A `RaceFinish` arrived. Prefers the MEASURED pause over the accrued one —
 *  it is exact and covers pauses that happened while we were disconnected. */
export function applyRaceFinish(
  clock: RaceClockState,
  rec: VenueRaceFinish,
  atMs: number,
): RaceClockState {
  const next = withIdentity(clock, rec);
  const actualStartMs = rec.actualStartMs ?? clock.actualStartMs;
  const durationMs = rec.durationMs ?? clock.durationMs;
  const measured = measuredPauseMs({ actualStartMs, actualEndMs: rec.actualEndMs, durationMs });
  return {
    ...next,
    phase: "finished",
    actualStartMs,
    durationMs,
    actualEndMs: rec.actualEndMs ?? clock.actualEndMs,
    pausedTotalMs: measured ?? clock.pausedTotalMs,
    pausedSinceMs: null,
    updatedAtMs: atMs,
  };
}

/** A `SessionDurationChangedNotification` arrived — staff moved the total. */
export function applyDurationChange(
  clock: RaceClockState,
  change: VenueDurationChange,
  atMs: number,
): RaceClockState {
  if (change.durationMs === null) return clock;
  return {
    ...clock,
    heatName: clock.heatName || change.sessionName,
    durationMs: change.durationMs,
    updatedAtMs: atMs,
  };
}

/**
 * Fold one broadcast message into a set of clocks. PURE — mutates only the map
 * it is handed, and returns the ids it touched.
 *
 * This is the single implementation of "what a message does to the clocks".
 * The Redis driver loads the affected races into a map, calls this, and writes
 * back; the tests call it with real captured snapshots. Deliberately shared:
 * a verification that re-implements the thing it verifies only tests itself
 * (the lesson from signage/live-probe.test.ts, and again from tonight's probes
 * that inherited the very bug they were meant to find).
 *
 * ORDER WITHIN A MESSAGE — duration change, stop, start, finish — so that a
 * snapshot carrying more than one record for a race lands deterministically
 * with the terminal state winning.
 */
export function foldMessageIntoClocks(
  clocks: Map<string, RaceClockState>,
  message: unknown,
  atMs: number,
): Set<string> {
  const starts = extractRaceStarts(message);
  const stops = extractRaceStops(message);
  const finishes = extractRaceFinishes(message);
  const changes = extractDurationChanges(message);

  const touched = new Set<string>([
    ...starts.map((r) => r.raceId),
    ...stops.map((r) => r.raceId),
    ...finishes.map((r) => r.raceId),
    ...changes.map((c) => c.raceId),
  ]);

  for (const raceId of touched) {
    let clock = clocks.get(raceId) ?? emptyClock(raceId, atMs);
    for (const c of changes) if (c.raceId === raceId) clock = applyDurationChange(clock, c, atMs);
    for (const r of stops) if (r.raceId === raceId) clock = applyRaceStop(clock, r, atMs);
    for (const r of starts) if (r.raceId === raceId) clock = applyRaceStart(clock, r, atMs);
    for (const r of finishes) if (r.raceId === raceId) clock = applyRaceFinish(clock, r, atMs);
    clocks.set(raceId, clock);
  }
  return touched;
}

/** How long after its last update a clock stops being worth showing. Covers a
 *  long pause plus the pending-finish window without keeping a wedged race
 *  (one sat "Started" for 62 minutes on 8/15) on a wall forever. */
export const CLOCK_STALE_MS = 90 * 60_000;

export function isStale(clock: RaceClockState, nowMs: number): boolean {
  return nowMs - clock.updatedAtMs > CLOCK_STALE_MS;
}
