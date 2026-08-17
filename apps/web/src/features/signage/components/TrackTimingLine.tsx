"use client";

/**
 * "On Time" / "+14 late" on a wall — the signage half of the on-time rework.
 *
 * Replaces the `DelayLine` that the pit board and the race check-in wall had each
 * grown their own copy of. Owner 2026-08-17: "on TV it should show late + or on
 * time" — so the TVs keep the verdict they always had, but it is finally OUR
 * verdict.
 *
 * WHY THAT IS NOT THE SAME BOARD AS BEFORE. The old figure came from a service
 * that only called a heat late once it was 30 minutes past its slot, which
 * marked one heat in a hundred and made "On Time" mean nothing. This measures
 * lateness at the CALL — the moment the printed slot actually names — so a green
 * wall is green because we called on time, not because being late was made
 * arithmetically impossible.
 *
 * IT IS DRIVEN BY THE MEDIAN, not the worst recent call, so one bad call cannot
 * flip a wall to amber and back between heats. That stability is the entire
 * reason the median is taken over three heats (features/racing/on-time.ts).
 *
 * Renders NOTHING when too little of tonight has been measured. A wall that says
 * "On Time" off two heats is worse than a wall that says nothing.
 */

import type { CurrentRace } from "@/hooks/useTrackStatus";
import type { OnTimeSnapshot } from "~/features/racing/on-time";
import { trackDisplay, verdictLabel } from "~/features/racing/on-time-display";
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

export default function TrackTimingLine({
  onTime,
  track,
  race,
  fontSize,
  okColor,
  warnColor,
  marginTop = 4,
}: TrackTimingLineProps) {
  const d = trackDisplay(onTime, track, slotMsOf(race));
  const label = verdictLabel(d);
  if (!label) return null;

  // Blink ONLY when we are actually late — the thing that is ours and fixable.
  // The ordinary ~17-minute briefing pipeline is normal and must never make a
  // wall flash, or the blink stops carrying meaning.
  const late = d.lateByMin !== null;
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
