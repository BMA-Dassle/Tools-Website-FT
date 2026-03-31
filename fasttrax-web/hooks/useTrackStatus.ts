"use client";

import { useEffect, useState } from "react";

const TRACK_STATUS_URL = "https://tools-track-status.vercel.app/api/v1/status";
const POLL_INTERVAL = 10_000; // 10 seconds

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

export function useTrackStatus() {
  const [data, setData] = useState<TrackStatusData | null>(null);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch(`${TRACK_STATUS_URL}?_t=${Date.now()}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (active) setData({ megaTrackEnabled: json.megaTrackEnabled, tracks: json.tracks });
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
