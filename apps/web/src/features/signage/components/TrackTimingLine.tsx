"use client";

/**
 * "Racing ~7:40" on a wall — the signage half of the on-time rework (2026-08-17).
 *
 * Replaces the `DelayLine` that the pit board and the race check-in wall had each
 * grown their own copy of. Both said "Running N behind / On time" off the outside
 * service's delay figure, which was green 99 nights in 100 (it only calls a heat
 * late once it is 30 minutes past its slot) and, on the nights it did fire, was
 * reporting the ordinary ~17-minute briefing pipeline as if it were a fault.
 *
 * These are GUEST walls — a racer standing in the pit or at the check-in desk
 * wants a time, not a verdict. So this shows when their heat actually goes,
 * predicted from the printed slot plus the track's live flag offset (86% within
 * 5 minutes for the next heat; see features/racing/on-time.ts).
 *
 * Falls back to the printed slot when we cannot predict, and renders NOTHING when
 * there is no heat checking in — a wall between heats has no honest time, and
 * "On time" is not a substitute for one.
 */

import type { CurrentRace } from "@/hooks/useTrackStatus";
import type { OnTimeSnapshot } from "~/features/racing/on-time";
import {
  roundPredictedMs,
  shouldShowPrediction,
  trackDisplay,
} from "~/features/racing/on-time-display";
import { slotMsOf } from "@/components/home/TrackTimingChip";

export interface TrackTimingLineProps {
  onTime: OnTimeSnapshot | null;
  /** "blue" | "red" | "mega" */
  track: string;
  /** The heat currently checking in on this track. */
  race: CurrentRace | null;
  /** Wall type scale — these boards range from 26px to 34px on this line. */
  fontSize: number;
  /** Amber for a track whose CALLS are late; green otherwise. */
  okColor: string;
  warnColor: string;
  marginTop?: number;
}

function etClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return "";
  }
}

export default function TrackTimingLine({
  onTime,
  track,
  race,
  fontSize,
  okColor,
  warnColor,
  marginTop = 4,
}: TrackTimingLineProps) {
  const slotMs = slotMsOf(race);
  const d = trackDisplay(onTime, track, slotMs);

  const label =
    shouldShowPrediction(d) && d.predictedStartMs !== null
      ? `Racing ~${etClock(roundPredictedMs(d.predictedStartMs))}`
      : slotMs !== null
        ? `Scheduled ${etClock(slotMs)}`
        : null;
  if (!label) return null;

  // Blink ONLY on a late call — the thing that is ours and fixable. The long
  // pipeline is normal and must never make a guest wall flash.
  const late = d.tone === "warn";
  const color = late ? warnColor : okColor;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop }}>
      <span
        aria-hidden
        className={late ? "tv-blink" : undefined}
        style={{ width: 11, height: 11, borderRadius: "50%", background: color }}
      />
      <span className="tv-display" style={{ fontSize, color }}>
        {label}
      </span>
    </div>
  );
}
