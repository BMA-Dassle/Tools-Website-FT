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
  const vip = decision.vip;
  if (!vip) return null;

  const step = bowlingStep(vip);

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
          {/* Rebranded 2026-08-10: it is "VIP Experience" now, not "The
              Ultimate VIP Experience" (owner). The live comboName wins when the
              feed carries one; this is only the fallback. */}
          {vip.comboName || "VIP Experience"}
        </div>

        <div
          className="tv-display tv-rise"
          style={{
            fontSize: 180,
            lineHeight: 0.92,
            textAlign: "center",
            whiteSpace: "nowrap",
            background: `linear-gradient(180deg, #f5ecee 48%, ${GOLD})`,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          {vip.title}
        </div>

        {/* No countdown (owner 2026-08-11: "doesn't need the in 8 min"). This
            is a greeting, not a schedule — the party already knows their time,
            and a number on a gold takeover reads as pressure. */}
        <div className="tv-display" style={{ fontSize: 62, color: "#fff", textAlign: "center" }}>
          VIP bowling{step?.lane ? ` · Lane ${step.lane}` : ""}
        </div>
      </div>
    </div>
  );
}

function bowlingStep(vip: VipEntry): VipStep | null {
  return vip.schedule.find((s) => isBowlingStep(s.label)) ?? null;
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
