"use client";

import { useEffect, useState } from "react";

const TRACK_STATUS_URL = "https://tools-track-status.vercel.app/api/v1/status";
const POLL_INTERVAL = 10_000; // 10 seconds

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
        // Fetch both in parallel
        const [statusRes, racesRes] = await Promise.all([
          fetch(`${TRACK_STATUS_URL}?_t=${Date.now()}`, { cache: "no-store" }),
          fetch(`/api/pandora/races-current?_t=${Date.now()}`, { cache: "no-store" }),
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
