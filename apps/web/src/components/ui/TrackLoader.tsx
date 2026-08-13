/**
 * Branded "working on it" loader — a lap running around a track.
 *
 * Why not the existing `Spinner`: that one is a 20px inline ring for buttons and
 * table rows, and it is the right tool there. This exists for the kiosk, where a
 * wait can run 15+ seconds on a 1080px-wide portrait screen and a 16px ring beside
 * 30px type reads as a frozen page rather than a working one. Bigger, and with a
 * leading edge so the eye can actually track motion.
 *
 * COLOUR COMES FROM `currentColor`, deliberately. This renders both on the cyan
 * CTA (where it must be dark) and on the dark overlay (where it must be light),
 * and it serves both brands — so it inherits rather than picking a side. No
 * hardcoded hex, nothing to keep in sync with a brand config.
 *
 * The 1400ms lap is the house beat (see KIOSK_GLOW_PERIODS_MS). It is NOT
 * registered there and must not be: that table exists to phase-lock attract
 * animations ACROSS kiosks, and a per-guest progress indicator has no business
 * being in lockstep with the screen next to it.
 *
 * Under `prefers-reduced-motion` the rings stop entirely. That is deliberate and
 * not a degraded state — the callers pair this with a label that changes as the
 * wait lengthens, so progress is still communicated in text.
 */
export default function TrackLoader({
  size = 28,
  label = "Working",
  className = "",
}: {
  /** Diameter in px. The kiosk passes ~44; inline callers can leave the default. */
  size?: number;
  /** Announced to screen readers. The visible label is the caller's own text. */
  label?: string;
  className?: string;
}) {
  // Geometry: r=44 in a 100-box leaves room for a 6-wide stroke without clipping.
  // The lap arc is ~22% of the circumference (2πr ≈ 276), long enough to read as
  // a moving segment rather than a dot chasing its tail.
  const r = 44;
  const circumference = 2 * Math.PI * r;
  const lap = circumference * 0.22;

  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        {/* The track. */}
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          opacity="0.18"
        />
        {/* Inner tick ring, counter-rotating at 2x the lap so the two never beat
            against each other in a way that looks like stutter. */}
        <g
          className="origin-center motion-safe:animate-[spin_2800ms_linear_infinite_reverse]"
          opacity="0.3"
        >
          <circle
            cx="50"
            cy="50"
            r="30"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="2 9"
            strokeLinecap="round"
          />
        </g>
        {/* The lap itself, with a leading dot at the head of the arc. Both live in
            one rotating group so the dot stays welded to the arc's front edge. */}
        <g className="origin-center motion-safe:animate-[spin_1400ms_linear_infinite]">
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${lap} ${circumference - lap}`}
            transform="rotate(-90 50 50)"
          />
          {/* Head of the lap: sits at the arc's leading end (-90° + 22% of 360°). */}
          <circle
            cx={50 + r * Math.cos(((-90 + 0.22 * 360) * Math.PI) / 180)}
            cy={50 + r * Math.sin(((-90 + 0.22 * 360) * Math.PI) / 180)}
            r="5.5"
            fill="currentColor"
          />
        </g>
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
