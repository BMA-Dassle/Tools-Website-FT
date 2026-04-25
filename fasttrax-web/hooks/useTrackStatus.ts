"use client";

import { useEffect, useState } from "react";

// Cached proxy on our own backend — see app/api/track-status/route.ts.
// Used to be tools-track-status.vercel.app directly, which meant every
// open ticket / homepage / e-ticket pinged the upstream service every
// 10s. Now they all hit our Redis-cached proxy instead, which fans
// down to one upstream call per ~30s across the whole site.
const TRACK_STATUS_URL = "/api/track-status";
const POLL_INTERVAL = 10_000; // 10 seconds — still polls fast for UI freshness, but mostly cache hits

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

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        // Fetch both in parallel. Both endpoints are server-cached:
        //   /api/track-status      — Redis 30s cache around the BMA upstream
        //   /api/pandora/races-current — 12s in-memory + Redis fallback
        const [statusRes, racesRes] = await Promise.all([
          fetch(TRACK_STATUS_URL, { cache: "no-store" }),
          fetch("/api/pandora/races-current", { cache: "no-store" }),
        ]);

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

        if (active) setData({ trackStatus, currentRaces });
      } catch {
        /* silent — keep last known state */
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return data;
}
