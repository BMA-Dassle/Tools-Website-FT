"use client";

/**
 * A neon display word — the loudest thing on an ad scene.
 *
 * THE GLOW NEVER ANIMATES. It is a static `text-shadow` painted once. The
 * flicker is a SECOND copy of the word stacked exactly on top, animating only
 * its opacity, which the compositor handles for free. Animating the text-shadow
 * itself would repaint a 170px glowing glyph run every frame, forever — the one
 * thing a screen that runs for weeks cannot afford.
 */
import { withAlpha } from "../color";

export function NeonWord({
  children,
  accent,
  size = 170,
  className,
}: {
  children: string;
  accent: string;
  size?: number;
  className?: string;
}) {
  // White-hot core, accent bloom, wide accent haze. Three stops read as real
  // neon; two read as a drop shadow.
  const glow = [
    "0 0 8px rgba(255,255,255,0.85)",
    `0 0 32px ${accent}`,
    `0 0 80px ${withAlpha(accent, 0.4)}`,
  ].join(", ");

  const base: React.CSSProperties = {
    fontSize: size,
    color: "#fff",
    textShadow: glow,
    whiteSpace: "nowrap",
  };

  return (
    <div className={`tv-display ${className ?? ""}`} style={{ position: "relative", ...base }}>
      {/* The steady word carries the layout. */}
      <span style={{ visibility: "hidden" }}>{children}</span>
      <span aria-hidden style={{ position: "absolute", inset: 0, ...base }}>
        {children}
      </span>
      {/* The flicker layer — opacity only. aria-hidden: it is the same word. */}
      <span
        aria-hidden
        className="tv-neon-flicker"
        style={{ position: "absolute", inset: 0, ...base }}
      >
        {children}
      </span>
    </div>
  );
}
