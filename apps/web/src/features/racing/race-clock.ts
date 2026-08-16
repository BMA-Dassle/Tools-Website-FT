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

export type RaceClockPhase = "armed" | "running" | "paused" | "finished";

export interface RaceClockState {
  raceId: string;
  heatName: string;
  heatNumber: number | null;
  track: TrackKey | null;
  phase: RaceClockPhase;
  /**
   * The venue's `ActualStart`. NOT the clock anchor — it is stamped at the
   * ARMING (phase one) and never moves afterwards. Kept for reference and for
   * the mid-race fallback below.
   */
  actualStartMs: number | null;
  /**
   * THE CLOCK ANCHOR: when the race actually went green (phase two), stamped
   * from message arrival. Null while merely armed.
   */
  clockStartMs: number | null;
  /** True when clockStartMs is a FALLBACK guess (we joined mid-race and never
   *  saw phase two), so a caller can distrust it. See applyRaceStart. */
  anchorEstimated: boolean;
  /**
   * RecordVersion of the last `RaceStart` we ACTED on. A start repeating a
   * version we have already folded is a reconnect replay, not a new event —
   * see the replay guard in applyRaceStart.
   *
   * Null on states written before this field existed, which is deliberately
   * permissive: a race already in flight when this deploys keeps behaving
   * exactly as it did rather than having its anchor re-judged mid-countdown.
   */
  lastStartRecordVersion: string | null;
  /** Latest configured length. Changes when staff add time. */
  durationMs: number | null;
  /** Pause time banked from COMPLETED pause intervals. */
  pausedTotalMs: number;
  /** When the current pause began (arrival-stamped), or null if running. */
  pausedSinceMs: number | null;
  actualEndMs: number | null;
  updatedAtMs: number;
}

/**
 * How stale a race's `ActualStart` can be, the FIRST time we ever see it, before
 * we conclude we joined mid-race rather than watching it arm.
 *
 * The observed arm→green gap is 65-76s (races 55884963 and 58586672,
 * 2026-08-15). Four minutes clears that comfortably while still catching a
 * genuine reconnect: on a bridge restart the catch-up dump replays in-flight
 * races as plain `Started` records with no phase-two bump to follow, and
 * without this they would sit "armed" forever and never show a clock.
 */
const MID_RACE_JOIN_MS = 4 * 60_000;

export function emptyClock(raceId: string, nowMs: number): RaceClockState {
  return {
    raceId,
    heatName: "",
    heatNumber: null,
    track: null,
    phase: "armed",
    actualStartMs: null,
    clockStartMs: null,
    anchorEstimated: false,
    lastStartRecordVersion: null,
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
  if (clock.durationMs === null) return null;
  // ARMED: the heat is staged and the karts are rolling out, but the race clock
  // has not started. It reads the full race length, static — which is exactly
  // what the venue's own screens show during this window.
  if (clock.phase === "armed") return clock.durationMs;
  if (clock.clockStartMs === null) return null;
  const openPause = clock.pausedSinceMs === null ? 0 : nowMs - clock.pausedSinceMs;
  return clock.clockStartMs + clock.durationMs + clock.pausedTotalMs + openPause - nowMs;
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
 * A finished race's TOTAL non-racing time: `(actualEnd − actualStart) − duration`.
 *
 * NOT the pause. This was originally written as "the measured pause" and used to
 * overwrite our accrued value — wrong, because BOTH ends of that span include
 * dead time that is not a pause (established 2026-08-15 from race 55884963):
 *
 *   - the front carries the ARM→GREEN gap, since `actualStart` is stamped at
 *     the arming, ~76s before the clock starts;
 *   - the tail carries the PENDING-FINISH window, since `actualEnd` is stamped
 *     when the session closes — 2:08 after the checkered flag on that race.
 *
 * So a 7:00 race with 106s of real pause showed 5:14 of "excess". Useful as a
 * diagnostic and for spotting races that overran, useless as a pause figure.
 * Last night's celebrated "9:23 of pause" was really gap + pauses + tail.
 */
export function measuredExcessMs(f: {
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
 * A `RaceStart` arrived — which is THREE different events wearing one name.
 *
 * THE TWO-PHASE START, measured off the wire 2026-08-15 (race 55884963):
 *
 *   16:13:38.013  RaceStart  State: undefined -> Started   rv ...118453000  <- ARM
 *   16:14:53.807  RaceStart  (only RecordVersion moved)    rv ...118614000  <- GREEN
 *
 * `ActualStart` reads 12:13:36.54 on BOTH and never changes, so anchoring the
 * countdown to it starts the clock 75.8 seconds early — the bug the owner
 * reported ("clock is starting on first start when it actually starts on
 * second", and again on 8/15 when the derived clock shipped with that flaw).
 *
 * The green flag is the SECOND start, and the proof is arithmetic: anchoring
 * there and adding the race length plus the observed pause predicts the
 * unstamped RaceFinish to within 1.9 seconds, where `ActualStart` is out by 76.
 *
 *   phase2 16:14:53.807 + 7:00 + 106.6s pause = 16:23:40.4
 *   observed RaceFinish                        = 16:23:42.3
 *
 * So the three cases, by the phase we are already in:
 *   armed    -> this is the GREEN. Anchor the clock to arrival time.
 *   paused   -> this is a RESUME. Bank the pause, keep the existing anchor.
 *   new race -> this is the ARM. Do not start counting.
 *
 * Duration is re-read every time, because a start following a time-add carries
 * the new total.
 *
 * ...AND A FOURTH CASE THAT LOOKS EXACTLY LIKE THE GREEN: A REPLAY.
 *
 * "The second RaceStart" is a statement about POSITION, and position is not
 * trustworthy on this feed. The bridge clears its dedupe cache on reconnect —
 * on purpose, so a catch-up dump is not swallowed — and that dump re-delivers
 * records verbatim. Captured live 2026-08-15 21:36:08, five races replayed in
 * one burst, every version already folded minutes before:
 *
 *   21:33:00  RaceStart  race 58586752  rv 13431438263023000   <- the ARM
 *   21:36:08  RaceStart  race 58586752  rv 13431438263023000   <- the SAME record
 *
 * That second arrival was read as heat 59's green flag and anchored the clock
 * 188s after the arm, where the night's real gaps ran 71-136s. Every Blue board
 * in the building was a minute slow, and the owner spotted it from the floor.
 *
 * So the green flag is the start whose RecordVersion MOVED — identity, not
 * arrival order. Same version means the same record said the same thing twice,
 * which is not an event.
 */
export function applyRaceStart(
  clock: RaceClockState,
  rec: VenueRaceFinish,
  atMs: number,
): RaceClockState {
  const next = withIdentity(clock, rec);
  const actualStartMs = rec.actualStartMs ?? clock.actualStartMs;
  const durationMs = rec.durationMs ?? clock.durationMs;
  const lastStartRecordVersion = rec.recordVersion ?? clock.lastStartRecordVersion;

  // REPLAY — a version we have already acted on. Change nothing about the
  // race's PHASE or anchor; a repeat is not a transition.
  //
  // Duration still lands: a staff time-add carried on an otherwise-repeated
  // record is real, and dropping it would freeze the clock at the old length.
  // `updatedAtMs` deliberately does NOT move — this record is not activity, and
  // letting it bump the timestamp would keep a dead race alive in the index.
  if (
    rec.recordVersion !== null &&
    clock.lastStartRecordVersion !== null &&
    rec.recordVersion === clock.lastStartRecordVersion
  ) {
    return { ...next, durationMs };
  }

  // RESUME — the race was paused; close the pause interval, anchor unchanged.
  if (clock.phase === "paused") {
    return {
      ...next,
      phase: "running",
      actualStartMs,
      durationMs,
      lastStartRecordVersion,
      pausedTotalMs:
        clock.pausedSinceMs === null
          ? clock.pausedTotalMs
          : clock.pausedTotalMs + Math.max(0, atMs - clock.pausedSinceMs),
      pausedSinceMs: null,
      updatedAtMs: atMs,
    };
  }

  // Already running: a repeated start record (the snapshot resends constantly)
  // must not re-anchor the clock and rewind the countdown.
  if (clock.phase === "running" || clock.phase === "finished") {
    return { ...next, actualStartMs, durationMs, lastStartRecordVersion, updatedAtMs: atMs };
  }

  // ARMED -> this is the green flag. THE anchor.
  if (clock.clockStartMs === null && clock.actualStartMs !== null) {
    return {
      ...next,
      phase: "running",
      actualStartMs,
      durationMs,
      lastStartRecordVersion,
      clockStartMs: atMs,
      anchorEstimated: false,
      updatedAtMs: atMs,
    };
  }

  /**
   * First sighting of this race. Normally that is the ARM, so we hold the clock
   * — but if its `ActualStart` is already well in the past we have joined
   * mid-race (a bridge restart replaying in-flight races in its catch-up dump),
   * and holding would mean never showing a clock at all. Fall back to
   * `ActualStart` and mark the anchor estimated: it runs ~75s fast, which is
   * wrong but visibly wrong in the right direction, and only until this race
   * ends.
   */
  const joinedMidRace = actualStartMs !== null && atMs - actualStartMs > MID_RACE_JOIN_MS;
  return {
    ...next,
    phase: joinedMidRace ? "running" : "armed",
    actualStartMs,
    durationMs,
    lastStartRecordVersion,
    clockStartMs: joinedMidRace ? actualStartMs : null,
    anchorEstimated: joinedMidRace,
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
  // A stop BEFORE the green flag is not a pause — there is no running clock to
  // freeze. Stay armed, so the next RaceStart is still read as the green rather
  // than as a resume (which would leave the clock with no anchor at all).
  if (clock.phase === "armed") {
    return {
      ...next,
      actualStartMs: rec.actualStartMs ?? clock.actualStartMs,
      durationMs: rec.durationMs ?? clock.durationMs,
      updatedAtMs: atMs,
    };
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

/**
 * A `RaceFinish` arrived — itself two-phase.
 *
 * Phase one is `State: "Finished"` with NO `ActualEnd` (the checkered flag, and
 * the fastest end signal we get); phase two stamps `ActualEnd` when the pending
 * window closes, 2:08 later on race 55884963. Both land here and both mean the
 * race is over, so the first one ends the clock and the second only fills in
 * the end time.
 *
 * KEEPS THE ACCRUED PAUSE. An earlier version overwrote it with
 * `(end − start) − duration`, which is not the pause at all — see
 * measuredExcessMs. Our accrual is built from actual RaceStop→RaceStart pairs
 * and is the honest figure.
 */
export function applyRaceFinish(
  clock: RaceClockState,
  rec: VenueRaceFinish,
  atMs: number,
): RaceClockState {
  const next = withIdentity(clock, rec);
  return {
    ...next,
    phase: "finished",
    actualStartMs: rec.actualStartMs ?? clock.actualStartMs,
    durationMs: rec.durationMs ?? clock.durationMs,
    actualEndMs: rec.actualEndMs ?? clock.actualEndMs,
    // Close any pause that was still open when the race ended.
    pausedTotalMs:
      clock.pausedSinceMs === null
        ? clock.pausedTotalMs
        : clock.pausedTotalMs + Math.max(0, atMs - clock.pausedSinceMs),
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
