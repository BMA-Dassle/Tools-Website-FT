"use client";

/**
 * House advertising — one attraction per 40s slot.
 *
 * Layout is deliberately asymmetric: content occupies the left ~half over a
 * hard scrim, and the photograph breathes on the right. A centred layout over a
 * full-bleed photo makes both fight; this way the picture is atmosphere and the
 * words are the message.
 *
 * WHICH slide is showing is derived from the shared clock, not from a local
 * counter — so every screen running this scene shows the same attraction at the
 * same moment, and a screen that reboots lands on the right one.
 */
import { TV_W } from "../constants";
import { tvAdSlides } from "../assets";
import { withAlpha } from "../color";
import { NeonWord } from "../components/NeonWord";
import { KioskCallout } from "../components/KioskCallout";
import { SLOT_MS } from "../director/schedule";
import type { SceneProps } from "../director/types";

/** TV-safe margins — 5% side, 5% top/bottom of a 1920×1080 frame. */
const PAD_X = 96;
const PAD_Y = 54;

export function SceneAdRotation({ feed, nowMs, venue }: SceneProps) {
  const slides = tvAdSlides(venue, feed?.pausedProductIds ?? []);
  // One slide per slot, clock-derived. Two screens agree; a reboot lands right.
  const slide = slides[Math.floor(nowMs / SLOT_MS) % slides.length];

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {/* Backdrop. Overdrawn 6% so the ken-burns pan and the burn-in drift can
          never reveal an edge. */}
      <div
        aria-hidden
        className="tv-kenburns"
        style={{
          position: "absolute",
          inset: "-6%",
          backgroundImage: `url(${slide.photo})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "saturate(0.78) brightness(0.82)",
        }}
      />

      {/* Scrim: opaque enough on the left to carry 170px type at any contrast,
          gone by the right third so the photograph still reads as a photograph. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to right, #000418 8%, rgba(2,10,34,0.80) 45%, rgba(2,10,34,0) 78%)",
        }}
      />

      {/* One light pass across the whole scene, phase-locked. */}
      <div aria-hidden className="tv-sweep" style={{ position: "absolute", inset: 0 }} />

      {/* Content */}
      <div
        style={{
          position: "absolute",
          left: PAD_X,
          top: PAD_Y,
          width: TV_W * 0.55,
          bottom: 120 + PAD_Y,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 28,
        }}
      >
        <div className="tv-eyebrow" style={{ color: slide.accent }}>
          Tonight at HeadPinz
        </div>

        <NeonWord accent={slide.accent}>{slide.word}</NeonWord>

        <p
          style={{
            fontSize: 44,
            lineHeight: 1.25,
            color: "rgba(245,236,238,0.9)",
            maxWidth: 860,
            margin: 0,
            textShadow: "0 2px 18px rgba(0,0,0,0.6)",
          }}
        >
          {slide.line}
        </p>

        {/* A thin accent rule anchors the block to the slide's identity. */}
        <div
          aria-hidden
          style={{
            width: 220,
            height: 5,
            borderRadius: 3,
            background: `linear-gradient(90deg, ${slide.accent}, ${withAlpha(slide.accent, 0)})`,
          }}
        />
      </div>

      <KioskCallout accent={slide.accent} text="Book it at any kiosk below" />
    </div>
  );
}
