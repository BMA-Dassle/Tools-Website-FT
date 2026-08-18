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
 * IT SHOWS A STATUS — "On Time" or "+14 late" — because that is what a thing
 * labelled LIVE TRACK STATUS is for (owner 2026-08-17: "this should be showing
 * the on-time or not").
 *
 * IT BRIEFLY SHOWED A CHECK-IN TIME AND THAT WAS WRONG, twice over. The earlier
 * note that a guest label must say check-in and never "race" was about the HEAT
 * CARDS, where a time is the whole point; carrying it into the status chip
 * replaced the verdict with a time. And it was redundant on every surface that
 * renders it: the "Now Checking In" line directly beside this chip already
 * prints that exact minute, so the chip repeated its neighbour and dropped the
 * one fact only it was carrying.
 *
 * The check-in time still belongs on the heat cards (KARTING CHECK IN) and on
 * the Now Checking In line. It does not belong here.
 */

import type { CurrentRace } from "@/hooks/useTrackStatus";
import type { OnTimeSnapshot } from "~/features/racing/on-time";
import { trackDisplay, verdictLabel, type OnTimeTone } from "~/features/racing/on-time-display";

/** "ok" is the ordinary state and stays quiet — and it is also the default when
 *  we know nothing (owner 2026-08-17). Amber means our CALLS are running late:
 *  ours, and fixable — never that the briefing pipeline is long. */
export function toneDotClass(tone: OnTimeTone): string {
  return tone === "warn" ? "bg-yellow-400" : "bg-green-400";
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

  // Always a verdict, never null — a board with nothing to say says "On Time"
  // (owner 2026-08-17). The slot is still passed in because the tone and the
  // day's figures are computed against it.
  const label = verdictLabel(d);

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
