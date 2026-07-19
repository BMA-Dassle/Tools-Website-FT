/**
 * Shared per-track visuals for the race heat grids — used by BOTH the Ultimate
 * combo picker (PackageHeatPicker) and the combined single-race grid
 * (RaceHeatPickerStep) so a multi-track grid looks identical in both: track-tinted
 * heat cards, track badges, and the track-info banner at the top of the grid.
 */

/** Small track pill (tier/track badges at the top of a heat card). */
export const TRACK_BADGE: Record<string, { bg: string; text: string }> = {
  Red: { bg: "bg-red-500/20", text: "text-red-300" },
  Blue: { bg: "bg-blue-500/20", text: "text-blue-300" },
  Mega: { bg: "bg-purple-500/20", text: "text-purple-300" },
};

/** Track-tinted heat-card themes — the "color layout" of the Ultimate grid. */
export const TRACK_CARD: Record<string, { base: string; baseHover: string; selected: string }> = {
  Red: {
    base: "border-red-500/60 bg-red-500/[0.14]",
    baseHover: "hover:border-red-400 hover:bg-red-500/20",
    selected: "border-red-300 bg-red-500/30 ring-2 ring-red-400/70",
  },
  Blue: {
    base: "border-blue-500/60 bg-blue-500/[0.14]",
    baseHover: "hover:border-blue-400 hover:bg-blue-500/20",
    selected: "border-blue-300 bg-blue-500/30 ring-2 ring-blue-400/70",
  },
  Mega: {
    base: "border-white/10 bg-white/5",
    baseHover: "hover:border-white/25 hover:bg-white/10",
    selected: "border-amber-500 bg-amber-500/15 ring-1 ring-amber-500/50",
  },
};

export const DISABLED_CARD =
  "border-white/[0.04] bg-white/[0.015] opacity-30 cursor-not-allowed grayscale";

/** Track-info cards shown at the TOP of a multi-track heat grid (length + style
 *  of each track). Blue is listed first to match the /racing marketing copy.
 *  When `onTrackClick` is provided the cards double as filter toggles: tap a
 *  track to show only its heats, tap it again to show all. */
export function TrackInfoBanner({
  tracks,
  activeTrack,
  onTrackClick,
}: {
  tracks: Array<"Red" | "Blue" | "Mega">;
  /** Currently applied track filter (null/undefined = showing all tracks). */
  activeTrack?: "Red" | "Blue" | "Mega" | null;
  /** Makes the cards clickable filter toggles. */
  onTrackClick?: (track: "Red" | "Blue" | "Mega") => void;
}) {
  const TRACK_DETAILS: Record<
    string,
    {
      title: string;
      stat: string;
      tagline: string;
      border: string;
      bg: string;
      titleClass: string;
      activeRing: string;
    }
  > = {
    Red: {
      title: "Red Track",
      stat: "1,095 ft",
      tagline: "Technical & clockwise — more turns, more strategy.",
      border: "border-red-500/40",
      bg: "bg-red-500/[0.08]",
      titleClass: "text-red-300",
      activeRing: "border-red-400 ring-2 ring-red-400/60",
    },
    Blue: {
      title: "Blue Track",
      stat: "1,013 ft",
      tagline: "High-speed & counter-clockwise — long straights, quick finishes.",
      border: "border-blue-500/40",
      bg: "bg-blue-500/[0.08]",
      titleClass: "text-blue-300",
      activeRing: "border-blue-400 ring-2 ring-blue-400/60",
    },
    Mega: {
      title: "Mega Track",
      stat: "2,108 ft",
      tagline: "Both tracks combined — the longest, fastest layout we run.",
      border: "border-purple-500/40",
      bg: "bg-purple-500/[0.08]",
      titleClass: "text-purple-300",
      activeRing: "border-purple-400 ring-2 ring-purple-400/60",
    },
  };

  const ordered = [...tracks].sort((a, b) => {
    if (a === "Blue") return -1;
    if (b === "Blue") return 1;
    return 0;
  });

  return (
    <div>
      <div
        className={`grid gap-2 ${ordered.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}
      >
        {ordered.map((track) => {
          const info = TRACK_DETAILS[track];
          if (!info) return null;
          const body = (
            <>
              <div className="mb-0.5 flex items-baseline justify-between gap-2">
                <h4 className={`font-display text-sm uppercase tracking-wider ${info.titleClass}`}>
                  {info.title}
                </h4>
                <span className="font-mono text-[11px] text-white/50">{info.stat}</span>
              </div>
              <p className="text-xs leading-snug text-white/65">{info.tagline}</p>
            </>
          );
          if (!onTrackClick) {
            return (
              <div
                key={track}
                className={`rounded-lg border ${info.border} ${info.bg} px-4 py-2.5`}
              >
                {body}
              </div>
            );
          }
          const isActive = activeTrack === track;
          const isDimmed = !!activeTrack && !isActive;
          return (
            <button
              key={track}
              type="button"
              aria-pressed={isActive}
              onClick={() => onTrackClick(track)}
              className={`cursor-pointer rounded-lg border px-4 py-2.5 text-left transition-all duration-150 ${info.bg} ${
                isActive ? info.activeRing : info.border
              } ${isDimmed ? "opacity-40" : ""}`}
            >
              {body}
            </button>
          );
        })}
      </div>
      {onTrackClick && (
        <p className="mt-1.5 text-center text-[11px] text-white/35">
          {activeTrack
            ? `Showing ${activeTrack} Track heats only — tap again to show all.`
            : "Tap a track to see only its heats."}
        </p>
      )}
    </div>
  );
}
