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
 * IT SHOWS THE KARTING CHECK-IN TIME (owner 2026-08-17: "shouldn't say race, it
 * should be check in time"). The printed slot is when to be at the desk, not
 * when the flag drops — the flag is a median 16 minutes later, so a chip reading
 * "Racing ~7:40" would send a guest to a desk that closed at 7:24.
 *
 * THE LABEL NAMES THE DESK, never the bare act. There are TWO check-ins in this
 * building half an hour apart on different floors — reservation check-in at
 * Guest Services on the 2nd, karting check-in at the 1st Floor counter — so
 * "Check-in 7:24" is true of two different times and a guest cannot tell which
 * he is reading. `KARTING_CHECKIN_LABEL_SHORT` is the sanctioned tight-surface
 * wording; lib/karting-checkin-copy.ts deliberately exports no generic form and
 * its guard test fails the build on any bare "check in".
 *
 * The time is stated, never predicted. Check-in lands on the slot (a median 1.6
 * min early, 3.9 min spread — the tightest span we measured), so there is no
 * drift to correct for and adjusting it would be inventing one.
 *
 * Renders nothing when no heat is checking in on this track. A wall between
 * heats has no honest time to give, and "On Time" is not a substitute for one.
 */

import type { CurrentRace } from "@/hooks/useTrackStatus";
import type { OnTimeSnapshot } from "~/features/racing/on-time";
import { KARTING_CHECKIN_LABEL_SHORT } from "@/lib/karting-checkin-copy";
import { trackDisplay, type OnTimeTone } from "~/features/racing/on-time-display";

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
    d.checkInAtMs !== null ? `${KARTING_CHECKIN_LABEL_SHORT} ${formatEtTime(d.checkInAtMs)}` : null;

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
