"use client";

import { useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";

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
  raceType: string;      // "Pro", "Intermediate", "Starter"
  heatNumber: number;
  scheduledStart: string; // ISO — the heat's scheduled start time (matches booked heatStart)
  calledAt: string;       // ISO — when BMI fired the SessionAboutToStart notification
  sessionId: number;
};

export type CurrentRaces = {
  blue: CurrentRace | null;
  red: CurrentRace | null;
  mega: CurrentRace | null;
};

// ── Combined return type ─────────────────────────────────────────────────────

export type TrackStatusResult = {
  trackStatus: TrackStatusData;
  currentRaces: CurrentRaces;
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useTrackStatus(): TrackStatusResult | null {
  const [data, setData] = useState<TrackStatusResult | null>(null);

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
        fetch("/api/pandora/races-current?prefer=cache", { cache: "no-store", signal }),
      ]);
      if (signal.aborted) return;

      const statusJson = await statusRes.json();
      const trackStatus: TrackStatusData = {
        megaTrackEnabled: statusJson.megaTrackEnabled,
        tracks: statusJson.tracks,
      };

      let currentRaces: CurrentRaces = { blue: null, red: null, mega: null };
      if (racesRes.ok) {
        const racesJson = await racesRes.json();
        // Apply Tuesday filter: follow megaTrackEnabled from the delay API.
        // If mega day, only show mega. Otherwise show blue/red.
        if (trackStatus.megaTrackEnabled) {
          currentRaces = { blue: null, red: null, mega: racesJson.mega ?? null };
        } else {
          currentRaces = { blue: racesJson.blue ?? null, red: racesJson.red ?? null, mega: null };
        }
      }

      if (signal.aborted) return;
      setData({ trackStatus, currentRaces });
    } catch {
      /* silent — keep last known state */
    }
  }, POLL_INTERVAL);

  return data;
}
