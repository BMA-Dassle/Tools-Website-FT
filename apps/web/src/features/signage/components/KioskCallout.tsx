"use client";

/**
 * The band along the bottom that points at the kiosks physically below the TV.
 *
 * This is the whole commercial point of the kiosk-bank screen: a guest looking
 * up at a 170px neon "BOWLING" needs to be told, without ambiguity, that the
 * machine at waist height in front of them will sell it. The arrows literally
 * point down at the bank.
 *
 * NO EMOJI — house rule. The downward arrows are @tabler/icons-react, animated
 * on transform only, staggered so they read as a wave rather than a twitch.
 */
import { IconArrowBigDownFilled } from "@tabler/icons-react";
import { withAlpha } from "../color";

const ARROW_COUNT = 3;

/**
 * `text` is REQUIRED. An arrow-only band was tried on the front-desk wall's how-to
 * panels, on the theory that the panel's own headline ("Buy a lane") already said
 * it — and the owner asked for the words back (2026-08-18). A guest reading a verb
 * eight feet up is not thereby told that the box at waist height in front of them
 * is how, and the arrows alone do not say it.
 */
export function KioskCallout({ accent, text }: { accent: string; text: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 120,
        background: "rgba(0,4,24,0.88)",
        borderTop: `3px solid ${accent}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 40,
        overflow: "hidden",
      }}
    >
      {/* Light passes along the band on the shared clock. */}
      <div aria-hidden className="tv-sweep" style={{ position: "absolute", inset: 0 }} />

      <Beacon accent={accent} />

      <div
        className="tv-display"
        style={{
          fontSize: 48,
          letterSpacing: "0.04em",
          color: "#fff",
          textShadow: `0 0 24px ${withAlpha(accent, 0.55)}`,
          zIndex: 1,
        }}
      >
        {text}
      </div>

      <Beacon accent={accent} />

      {/* Arrows sit across the band, each nodding downward a beat apart. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 96px",
          pointerEvents: "none",
        }}
      >
        {Array.from({ length: ARROW_COUNT }, (_, i) => (
          <IconArrowBigDownFilled
            key={i}
            size={44}
            color={accent}
            className="tv-chev"
            // Phase within the shared 2.4s cycle, so the wave travels
            // left-to-right instead of all three moving as one.
            data-glow-phase-ms={i * 300}
            style={{ opacity: 0.85 }}
          />
        ))}
      </div>
    </div>
  );
}

function Beacon({ accent }: { accent: string }) {
  return (
    <span
      aria-hidden
      className="tv-blink"
      style={{
        width: 14,
        height: 14,
        borderRadius: "50%",
        background: accent,
        boxShadow: `0 0 16px ${accent}`,
        zIndex: 1,
      }}
    />
  );
}
