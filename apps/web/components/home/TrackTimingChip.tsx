"use client";

/**
 * The dot + timing line that replaced "On Time / +N Min", everywhere.
 *
 * There were five near-identical copies of `dotColor(t.status)` + `{t.delayFormatted}`
 * across the home widget, the racer journey and both confirmation flows. Changing
 * the meaning of that line — from a delay we mostly could not measure to a time we
 * can — would have meant five divergent edits, and tasks/lessons.md is explicit
 * about how that ends ("extracted component misses later fixes"). One component,
 * one meaning.
 *
 * WHAT IT SAYS, in order of preference:
 *   1. "Racing ~7:40"    we have a slot and the track's live flag offset
 *   2. "Scheduled 7:24"  we have the printed slot but cannot predict yet
 *   3. nothing           no heat is checking in — a track between heats has no
 *                        honest time, and "On Time" is not a substitute
 *
 * See features/racing/on-time.ts for why the raw slot→flag gap is NOT shown as a
 * delay, and on-time-display.ts for the tone rules.
 */

import type { CurrentRace } from "@/hooks/useTrackStatus";
import type { OnTimeSnapshot } from "~/features/racing/on-time";
import {
  roundPredictedMs,
  shouldShowPrediction,
  trackDisplay,
  type OnTimeTone,
} from "~/features/racing/on-time-display";

/** "ok" is the ordinary state and stays quiet. Amber means our CALLS are running
 *  late — ours, and fixable — never that the briefing pipeline is long. */
export function toneDotClass(tone: OnTimeTone): string {
  return tone === "ok" ? "bg-green-400" : tone === "warn" ? "bg-yellow-400" : "bg-white/40";
}

export function formatEtTime(ms: number): string {
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

/** The heat's slot as epoch ms, or null — races-current sends it as an ISO string. */
export function slotMsOf(race: CurrentRace | null | undefined): number | null {
  if (!race?.scheduledStart) return null;
  const ms = Date.parse(race.scheduledStart);
  return Number.isFinite(ms) ? ms : null;
}

export interface TrackTimingChipProps {
  onTime: OnTimeSnapshot | null;
  /** "blue" | "red" | "mega" */
  track: string;
  /** The heat currently checking in on this track, if any. */
  race: CurrentRace | null;
  /** Tailwind size for the dot, e.g. "w-2 h-2". */
  dotClassName?: string;
  /** Tailwind (or inline-styled) classes for the text. */
  textClassName?: string;
  /** Inline style for the text, for the surfaces that size in px. */
  textStyle?: React.CSSProperties;
  /** Pulse the dot, matching whatever the host surface already did. */
  pulse?: boolean;
}

export default function TrackTimingChip({
  onTime,
  track,
  race,
  dotClassName = "w-2 h-2",
  textClassName = "text-white/70 text-sm",
  textStyle,
  pulse = false,
}: TrackTimingChipProps) {
  const slotMs = slotMsOf(race);
  const d = trackDisplay(onTime, track, slotMs);

  const label =
    shouldShowPrediction(d) && d.predictedStartMs !== null
      ? `Racing ~${formatEtTime(roundPredictedMs(d.predictedStartMs))}`
      : slotMs !== null
        ? `Scheduled ${formatEtTime(slotMs)}`
        : null;

  return (
    <div className="flex items-center gap-2">
      <span
        className={`${dotClassName} rounded-full ${toneDotClass(d.tone)}${pulse ? " animate-pulse" : ""}`}
      />
      {label && (
        <span className={textClassName} style={textStyle}>
          {label}
        </span>
      )}
    </div>
  );
}
