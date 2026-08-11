"use client";

/**
 * The VIP takeover — a party's bowling leg is minutes away.
 *
 * Fires between about ten and three minutes out. It stops at three on purpose:
 * by then they are walking up, and a countdown telling a paying VIP party they
 * are nearly late is worse than showing them nothing at all.
 *
 * Gold, and nothing else on screen. This is the one moment the wall speaks to a
 * single party by name, so anything else on it competes with that.
 */
import { IconCrown } from "@tabler/icons-react";
import { withAlpha } from "../color";
import { TV_PHOTOS } from "../assets";
import { isBowlingStep } from "../director/schedule";
import type { VipEntry, VipStep } from "../types";
import type { SceneProps } from "../director/types";

const GOLD = "#d4af37";
const GOLD_SOFT = "#e8b14c";
const PARTICLES = 36;

export function SceneVipWelcome({ decision }: SceneProps) {
  // Every in-window party shares the screen at once (owner 2026-08-11) —
  // "soonest wins" left the second family ungreeted, and a rotation meant
  // whoever glanced up during the other party's turn missed their own name.
  const parties = decision.vips?.length ? decision.vips : decision.vip ? [decision.vip] : [];
  if (parties.length === 0) return null;
  const eyebrow = parties[0].comboName || "VIP Experience";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* NOT the HyperBowling photo. That shot's lane screens carry their own
          marketing slogan ("NO MATTER WHO YOU ARE…"), which on a wall reads as
          OUR copy, garbled (owner 2026-08-11: "the background says no matter
          who you are instead of a nice image"). A photo with words in it is a
          photo that talks over the scene. */}
      <div
        aria-hidden
        className="tv-kenburns"
        style={{
          position: "absolute",
          inset: "-6%",
          backgroundImage: `url(${TV_PHOTOS.bowl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          opacity: 0.5,
          filter: "saturate(0.8) brightness(0.7)",
        }}
      />
      {/* Gold wash + vignette: the picture should feel lit from the middle. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(60% 50% at 50% 40%, ${withAlpha(GOLD, 0.28)}, transparent 72%),
                       radial-gradient(90% 90% at 50% 50%, transparent 40%, #000418 92%)`,
        }}
      />

      <GoldDrift />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
          padding: "0 96px",
        }}
      >
        <IconCrown size={96} color={GOLD} style={{ filter: `drop-shadow(0 0 28px ${GOLD})` }} />

        <div
          className="tv-eyebrow"
          style={{ color: GOLD_SOFT, fontSize: 30, letterSpacing: "0.32em" }}
        >
          {/* Rebranded 2026-08-10: "VIP Experience", not "The Ultimate VIP
              Experience" (owner). The live comboName wins when the feed
              carries one; this is only the fallback. */}
          {eyebrow}
        </div>

        {/* One block per party, all on screen together. No countdown (owner:
            "doesn't need the in 8 min") — a greeting, not a schedule. */}
        {parties.map((vip, i) => (
          <PartyName key={vip.id} vip={vip} count={parties.length} index={i} />
        ))}
      </div>
    </div>
  );
}

function bowlingStep(vip: VipEntry): VipStep | null {
  return vip.schedule.find((s) => isBowlingStep(s.label)) ?? null;
}

/**
 * One party's name and lane. Sized to FIT, painted so it cannot clip.
 *
 * Two separate cut-off bugs live in naive versions of this block, and both have
 * now happened on the real wall (owner 2026-08-11, twice):
 *
 *  1. LENGTH. A fixed 180px with nowrap fits "SARAH" and runs off the canvas
 *     for "Alexandria's". The size is derived from the name length and the
 *     available width — deterministic, no measuring, same on every screen.
 *  2. PAINT. background-clip:text with a sub-1 line-height slices glyph paint
 *     at the line box on a transform-scaled canvas — italic overhang and the
 *     gradient bottom go missing. Line-height ≥ 1 plus em-padding gives the
 *     glyphs room; the flex parent does not clip.
 */
function PartyName({ vip, count, index }: { vip: VipEntry; count: number; index: number }) {
  const step = bowlingStep(vip);
  // Canvas 1920 minus the 96px side padding on each side.
  const budgetPx = 1920 - 2 * 96;
  const maxPx = count === 1 ? 180 : count === 2 ? 128 : 96;
  // Exo 2 800 italic uppercase runs ~0.68em average advance per glyph.
  const fitted = Math.min(maxPx, Math.floor(budgetPx / (0.68 * Math.max(4, vip.title.length))));

  return (
    <div className="tv-rise" style={{ textAlign: "center", animationDelay: `${index * 120}ms` }}>
      <div
        className="tv-display"
        style={{
          fontSize: fitted,
          lineHeight: 1.04,
          padding: "0 0.14em",
          whiteSpace: "nowrap",
          background: `linear-gradient(180deg, #f5ecee 48%, ${GOLD})`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        {vip.title}
      </div>
      <div
        className="tv-display"
        style={{ fontSize: count === 1 ? 62 : 40, color: "#fff", marginTop: count === 1 ? 8 : 2 }}
      >
        VIP bowling{step?.lane ? ` · Lane ${step.lane}` : ""}
      </div>
    </div>
  );
}

/**
 * Gold motes drifting upward.
 *
 * One shared keyframe; every particle's duration and drift come from its index,
 * so the field is deterministic — identical on two screens, and it cannot
 * reshuffle on a re-render. Transform and opacity only, and the whole field
 * unmounts with the scene.
 */
function GoldDrift() {
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {Array.from({ length: PARTICLES }, (_, i) => {
        const size = 4 + ((i * 7) % 5);
        const dur = 14_000 + ((i * 613) % 10_000);
        const x = ((i * 53) % 100) / 100;
        const drift = (((i * 29) % 60) - 30) * 4;
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              bottom: -20,
              left: `${x * 100}%`,
              width: size,
              height: size,
              borderRadius: "50%",
              background: i % 3 === 0 ? GOLD_SOFT : GOLD,
              opacity: 0,
              animation: `tv-float ${dur}ms linear ${(i % 14) * 900}ms infinite`,
              ["--dx" as string]: `${drift}px`,
            }}
          />
        );
      })}
    </div>
  );
}
