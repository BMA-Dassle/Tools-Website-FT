"use client";

/**
 * Two-up Red / Blue track info card. Rendered above heat grids in
 * any picker that surfaces multi-track choices to the customer
 * (PackageHeatPicker and the mixed-track branch of PackHeatPicker).
 *
 * Shared between pickers so the descriptions stay in lockstep —
 * editing the Red description here updates both Ultimate Qualifier
 * weekday/weekend AND the weekday Intermediate 3-pack picker.
 */

const TRACK_DETAILS: Record<"Red" | "Blue" | "Mega", {
  title: string;
  stat: string;
  tagline: string;
  /** Tailwind color tokens — paired so the panel reads as the same
   *  visual language as the heat cards below. */
  border: string;
  bg: string;
  titleClass: string;
}> = {
  Red: {
    title: "Red Track",
    stat: "1,095 ft",
    tagline: "Technical & clockwise — more turns, more strategy.",
    border: "border-red-500/40",
    bg: "bg-red-500/[0.08]",
    titleClass: "text-red-300",
  },
  Blue: {
    title: "Blue Track",
    stat: "1,013 ft",
    tagline: "High-speed & counter-clockwise — long straights, quick finishes.",
    border: "border-blue-500/40",
    bg: "bg-blue-500/[0.08]",
    titleClass: "text-blue-300",
  },
  Mega: {
    title: "Mega Track",
    stat: "2,108 ft",
    tagline: "Both tracks combined — the longest, fastest layout we run.",
    border: "border-purple-500/40",
    bg: "bg-purple-500/[0.08]",
    titleClass: "text-purple-300",
  },
};

/** Given a list of tracks, render a side-by-side info banner. Defaults
 *  to Blue first when both are present (matches /racing marketing copy
 *  order). Single-track callers should skip this banner entirely —
 *  there's nothing to choose between. */
export default function TrackInfoBanner({ tracks }: { tracks: Array<"Red" | "Blue" | "Mega"> }) {
  const ordered = [...tracks].sort((a, b) => {
    if (a === "Blue") return -1;
    if (b === "Blue") return 1;
    return 0;
  });
  return (
    <div className={`grid gap-2 ${ordered.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
      {ordered.map((track) => {
        const info = TRACK_DETAILS[track];
        if (!info) return null;
        return (
          <div
            key={track}
            className={`rounded-lg border ${info.border} ${info.bg} px-4 py-2.5`}
          >
            <div className="flex items-baseline justify-between gap-2 mb-0.5">
              <h4 className={`font-display text-sm uppercase tracking-wider ${info.titleClass}`}>
                {info.title}
              </h4>
              <span className="text-white/50 text-[11px] font-mono">{info.stat}</span>
            </div>
            <p className="text-white/65 text-xs leading-snug">{info.tagline}</p>
          </div>
        );
      })}
    </div>
  );
}
