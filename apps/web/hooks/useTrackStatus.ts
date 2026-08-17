"use client";

import { useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import type { OnTimeSnapshot as OnTimeSnapshotType } from "~/features/racing/on-time";
import { dataSaysMega } from "~/features/racing/mega-mode";

// Cached proxy on our own backend — see app/api/track-status/route.ts.
// Used to be tools-track-status.vercel.app directly, which meant every
// open ticket / homepage / e-ticket pinged the upstream service every
// 10s. Now they all hit our Redis-cached proxy instead, which fans
// down to one upstream call per ~30s across the whole site.
const TRACK_STATUS_URL = "/api/track-status";
// 20s cadence — matches the upstream cache TTL (~30s) so we pick up
// fresh state on the next refresh without firing 3× more requests
// than we need. Was 10s, which doubled per-tab work on long-lived
// pages (e-tickets, leaderboards) for no UI benefit.
const POLL_INTERVAL = 20_000;

// ── Track delay / running status (existing) ──────────────────────────────────

export type TrackInfo = {
  trackName: string;
  delayMinutes: number;
  isRunning: boolean;
  status: string;
  statusText: string;
  delayFormatted: string;
  colors: {
    status: string;
    statusBlink: string | null;
    trackIdentity: string;
  };
};

export type TrackStatusData = {
  megaTrackEnabled: boolean;
  tracks: TrackInfo[];
};

// ── Currently checking-in race per track (new — from Pandora) ────────────────

export type CurrentRace = {
  trackName: string;
  raceType: string; // "Pro", "Intermediate", "Starter"
  heatNumber: number;
  scheduledStart: string; // ISO — the heat's scheduled start time (matches booked heatStart)
  calledAt: string; // ISO — when BMI fired the SessionAboutToStart notification
  sessionId: number;
};

export type CurrentRaces = {
  blue: CurrentRace | null;
  red: CurrentRace | null;
  mega: CurrentRace | null;
};

// ── OUR OWN on-time picture (2026-08-17) ─────────────────────────────────────

/**
 * Computed from our archives, not bought from the BMA service — see
 * features/racing/on-time.ts for why the two disagree and which one is right.
 *
 * Null when the kill switch is off, when the read failed, or on an old cached
 * payload. Every consumer must handle null by falling back to the printed
 * schedule rather than inventing a time.
 */
export type { OnTimeSnapshot, TrackOnTime } from "~/features/racing/on-time";

// ── Combined return type ─────────────────────────────────────────────────────

export type TrackStatusResult = {
  trackStatus: TrackStatusData;
  currentRaces: CurrentRaces;
  onTime: OnTimeSnapshotType | null;
};

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param pollMs poll cadence. The default (20s) is for guest pages and reads
 * races-current with `prefer=cache`. STAFF/SIGNAGE surfaces pass a fast
 * cadence (1-2s, owner 2026-08-14: "1 second is the minimums" for session
 * status) — fast mode reads `cacheOnly=1`, which never touches live Pandora:
 * the races-current-warm loop keeps the Redis carry ~1-2s fresh, so the fast
 * read IS the realtime read and a Pandora stall can never stack requests
 * from a fleet of boards.
 */
export function useTrackStatus(pollMs: number = POLL_INTERVAL): TrackStatusResult | null {
  const [data, setData] = useState<TrackStatusResult | null>(null);
  const racesUrl =
    pollMs < POLL_INTERVAL
      ? "/api/pandora/races-current?cacheOnly=1"
      : "/api/pandora/races-current?prefer=cache";

  // Drive polling through useVisibleInterval so we:
  //   1. PAUSE when the tab is hidden — was firing every 10s on
  //      long-lived background pages (e-tickets, leaderboards),
  //      accumulating fetches Edge eventually killed the renderer
  //      for. Symptom was "This page couldn't load" after ~5 min
  //      with the ticket open, especially on laptop backgrounds.
  //   2. ABORT in-flight requests on tab-hidden / unmount, so slow
  //      Pandora fetches don't leak Response/JSON allocations after
  //      the user moves away.
  //   3. NO OVERLAP — setTimeout-recursive cadence; the next tick
  //      only schedules after the current cycle settles. Eliminates
  //      the failure mode where a slow Pandora response let cycle-
  //      N+1 fire before cycle-N's promises resolved.
  useVisibleInterval(async (signal) => {
    try {
      // Fetch both in parallel. Both endpoints are server-cached:
      //   /api/track-status      — Redis 30s cache around the BMA upstream
      //   /api/pandora/races-current?prefer=cache — Redis-first read,
      //     warmed every minute by /api/cron/checkin-alerts. The
      //     `prefer=cache` mode keeps browser polls off the live
      //     Pandora call entirely, so a hung Pandora doesn't make the
      //     confirmation/e-ticket pages feel broken.
      const [statusRes, racesRes] = await Promise.all([
        fetch(TRACK_STATUS_URL, { cache: "no-store", signal }),
        fetch(racesUrl, { cache: "no-store", signal }),
      ]);
      if (signal.aborted) return;

      // Guard statusRes.ok (the racesRes read below already does). A non-200
      // or error payload from /api/track-status yields no `tracks` array; if we
      // let that through, every consumer's `trackData.tracks.map(...)` throws
      // "undefined is not an object (evaluating 'tracks.map')" at render — a
      // crash we were seeing on the home page (Clarity, ~94 sessions/14d).
      // Treat a bad/empty status payload as a no-op cycle and keep last-known
      // good state rather than blanking (or crashing) the UI.
      const statusJson = statusRes.ok ? await statusRes.json() : null;
      if (!statusJson || !Array.isArray(statusJson.tracks)) return;
      const trackStatus: TrackStatusData = {
        megaTrackEnabled: Boolean(statusJson.megaTrackEnabled),
        tracks: statusJson.tracks,
      };
      // Ours rides along on the same payload. Absent (kill switch off, read
      // failed, older deploy still serving) is a first-class case: consumers
      // fall back to the printed schedule rather than to a made-up time.
      const onTime: OnTimeSnapshotType | null =
        statusJson.onTime && typeof statusJson.onTime === "object"
          ? (statusJson.onTime as OnTimeSnapshotType)
          : null;

      let currentRaces: CurrentRaces = { blue: null, red: null, mega: null };
      let effectiveMega = trackStatus.megaTrackEnabled;
      if (racesRes.ok) {
        const racesJson = await racesRes.json();
        // EFFECTIVE MEGA = the external flag OR the data signal. The flag is
        // flipped by a human on the delay service and lags the physical
        // barrier; the races-current carry cannot lie about which circuit
        // called the newest heat. dataSaysMega is inert on a normal day
        // because the mega carry key does not exist then. The override is
        // applied IN PLACE on megaTrackEnabled — every consumer reads that
        // field as "are we in mega mode right now", and none needs the raw
        // upstream value.
        effectiveMega = trackStatus.megaTrackEnabled || dataSaysMega(racesJson);
        currentRaces = effectiveMega
          ? { blue: null, red: null, mega: racesJson.mega ?? null }
          : { blue: racesJson.blue ?? null, red: racesJson.red ?? null, mega: null };
      }

      if (signal.aborted) return;
      setData({
        trackStatus: { ...trackStatus, megaTrackEnabled: effectiveMega },
        currentRaces,
        onTime,
      });
    } catch {
      /* silent — keep last known state */
    }
  }, pollMs);

  return data;
}
