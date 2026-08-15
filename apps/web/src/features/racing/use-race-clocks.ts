"use client";

/**
 * The race countdown on a screen — fetched once per page, ticked locally.
 *
 * A countdown is deterministic once you know start, duration and banked pause,
 * so there is no reason for every TV in the building to ask the server what
 * second it is, and no reason for the four chips on ONE screen to each poll.
 * This is a module-level store: one fetch loop and one ticker no matter how
 * many components subscribe, refcounted so it stops when the last unmounts.
 *
 * CLOCK SKEW IS HANDLED, deliberately: shop TVs keep bad time, and a wall
 * showing a countdown ninety seconds off is worse than one showing nothing.
 * Each fetch records the gap between the server's clock and ours, and every
 * local tick applies it — so the screens agree with each other and with the
 * desk even when a TV's own clock does not.
 */
import { useEffect, useState } from "react";
import { formatClock } from "./race-clock";

export interface RaceClockTerms {
  raceId: string;
  heatName: string;
  heatNumber: number | null;
  track: string | null;
  phase: "armed" | "running" | "paused" | "finished";
  remainingMs: number | null;
  clockStartMs: number | null;
  anchorEstimated: boolean;
  actualStartMs: number | null;
  durationMs: number | null;
  pausedTotalMs: number;
  pausedSinceMs: number | null;
}

export interface TickedRaceClock extends RaceClockTerms {
  /** Recomputed locally each second, skew-corrected. Null when unknowable. */
  liveRemainingMs: number | null;
  /** Clamped at zero and formatted "m:ss" — what a wall should render. */
  display: string | null;
  /** True once a race has run past its clock but has not been finished. */
  overrun: boolean;
}

export interface RaceClockStore {
  clocks: TickedRaceClock[];
  loading: boolean;
  /** No successful fetch in a while — the bridge or the feed is down. A caller
   *  may dim rather than show a confident number. */
  stale: boolean;
}

/** How often to re-read the terms. Fast enough that a pause or a staff
 *  time-add reaches the wall in a few seconds, slow enough to be nothing. */
const REFRESH_MS = 10_000;
/** Display cadence. The terms do not change between fetches; only `now` does. */
const TICK_MS = 1000;

/** Mirrors remainingMs() in race-clock.ts — kept in step deliberately, because
 *  the server value would be up to REFRESH_MS stale between polls. */
function computeLive(c: RaceClockTerms, nowMs: number): number | null {
  if (c.phase === "finished") return 0;
  if (c.durationMs === null) return null;
  // Armed: staged, karts rolling out, clock not started. Full length, static.
  if (c.phase === "armed") return c.durationMs;
  if (c.clockStartMs === null) return null;
  const openPause = c.pausedSinceMs === null ? 0 : nowMs - c.pausedSinceMs;
  return c.clockStartMs + c.durationMs + c.pausedTotalMs + openPause - nowMs;
}

let terms: RaceClockTerms[] = [];
let skewMs = 0;
let lastOkMs = 0;
let loading = true;
let snapshot: RaceClockStore = { clocks: [], loading: true, stale: false };
const listeners = new Set<() => void>();
let refCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

function rebuild(): void {
  const now = Date.now() + skewMs;
  const clocks = terms.map((c) => {
    const live = computeLive(c, now);
    return {
      ...c,
      liveRemainingMs: live,
      display: live === null ? null : formatClock(Math.max(0, live)),
      overrun: live !== null && live < 0 && c.phase !== "finished",
    };
  });
  snapshot = {
    clocks,
    loading,
    stale: lastOkMs > 0 && Date.now() - lastOkMs > REFRESH_MS * 3,
  };
  for (const l of listeners) l();
}

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/racing/race-clock", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { serverNowMs: number; clocks: RaceClockTerms[] };
    // Measured before any other work so the offset reflects the network rather
    // than our own render queue.
    skewMs = data.serverNowMs - Date.now();
    lastOkMs = Date.now();
    terms = Array.isArray(data.clocks) ? data.clocks : [];
  } catch {
    // Keep the last known terms ticking — a blip in the poll must not blank a
    // wall mid-race. `stale` is how a caller notices.
  } finally {
    loading = false;
    rebuild();
  }
}

function start(): void {
  if (pollTimer) return;
  void load();
  pollTimer = setInterval(() => void load(), REFRESH_MS);
  tickTimer = setInterval(rebuild, TICK_MS);
}

function stop(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
}

/** Every live race clock, shared across all subscribers on the page. */
export function useRaceClocks(): RaceClockStore {
  const [, force] = useState(0);

  useEffect(() => {
    refCount++;
    start();
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      refCount--;
      if (refCount === 0) stop();
    };
  }, []);

  return snapshot;
}

/**
 * The clock for one track, or null when nothing is live on it.
 *
 * Picks the most recently started NON-finished race — the venue keeps finished
 * races in the set, and a wedged one can linger (a race sat "Started" for 62
 * minutes on 2026-08-15), so "newest start wins" is what matches the track.
 */
export function useRaceClockForTrack(track: string | null): TickedRaceClock | null {
  const { clocks } = useRaceClocks();
  if (!track) return null;
  const live = clocks
    .filter((c) => c.track === track && c.phase !== "finished")
    .sort((a, b) => (b.actualStartMs ?? 0) - (a.actualStartMs ?? 0));
  return live[0] ?? null;
}
