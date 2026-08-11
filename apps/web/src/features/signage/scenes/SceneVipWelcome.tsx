"use client";

/**
 * The VIP slide — gold, and a sibling of the welcome board.
 *
 * NOT A TAKEOVER (owner 2026-08-11: "it shouldn't just take over everything,
 * that doesn't make sense"). VipShowcase is a SLIDE the welcome board
 * interleaves between its own pages — welcome 1, VIP, welcome 2, VIP — so VIP
 * parties get repeated prominence without seizing the wall.
 *
 * Layout mirrors the welcome board (owner): brand rail on the left, one gold
 * glass tile per party on the right, every in-window party on screen at once.
 */
import { IconCrown, IconUsersGroup } from "@tabler/icons-react";
import { withAlpha } from "../color";
import { TV_PHOTOS } from "../assets";
import { isBowlingStep, vipCandidatesAt } from "../director/schedule";
import { formatLanes } from "../lanes";
import type { VipEntry, VipStep } from "../types";
import type { SceneProps } from "../director/types";

const GOLD = "#d4af37";
const GOLD_SOFT = "#e8b14c";
const PARTICLES = 36;

const PAD_X = 96;
const PAD_Y = 54;
/** Same rail width as the welcome board, so the two scenes read as siblings. */
const RAIL_PX = 560;

/**
 * Font size that FITS a word in the rail. Derived, never eyeballed — the
 * welcome board shipped a 168px headline into a 560px rail and the wall read
 * "WELCO" (owner). Exo 2 800 italic uppercase runs ~0.68em advance per glyph.
 */
function railFit(word: string, capPx: number): number {
  return Math.min(capPx, Math.floor(RAIL_PX / (0.68 * Math.max(3, word.length))));
}

/**
 * Standalone scene form, for a screen whose playlist names vip-welcome
 * directly. Shows the in-window parties; with none in window it shows every
 * known party rather than a blank wall.
 */
export function SceneVipWelcome({ feed, nowMs, config }: SceneProps) {
  const inWindow = vipCandidatesAt(nowMs, feed?.vip ?? null, config.vip, isBowlingStep).map(
    (c) => c.vip,
  );
  const parties = inWindow.length > 0 ? inWindow : (feed?.vip ?? []);
  if (parties.length === 0) return null;
  return <VipShowcase parties={parties} />;
}

/** The gold slide itself — also rendered by the welcome board's rotation. */
export function VipShowcase({ parties }: { parties: VipEntry[] }) {
  if (parties.length === 0) return null;

  // Rebranded 2026-08-10: "VIP Experience", not "The Ultimate VIP Experience"
  // (owner). The live comboName wins when the feed carries one. Rendered one
  // word per line so each line can be sized to genuinely fit the rail.
  const brandWords = (parties[0].comboName || "VIP Experience").split(/\s+/);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* NOT the HyperBowling photo. That shot's lane screens carry their own
          marketing slogan ("NO MATTER WHO YOU ARE…"), which on a wall reads as
          OUR copy, garbled (owner 2026-08-11). A photo with words in it is a
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
          opacity: 0.45,
          filter: "saturate(0.8) brightness(0.7)",
        }}
      />
      {/* Scrim heavier on the left so the rail always carries, gold wash so the
          whole frame reads as the gold moment even at a glance. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(to right, #000418 22%, rgba(2,10,34,0.8) 55%, rgba(2,10,34,0.35) 100%),
                       radial-gradient(60% 50% at 50% 40%, ${withAlpha(GOLD, 0.22)}, transparent 72%)`,
        }}
      />

      <GoldDrift />

      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          gap: 64,
          alignItems: "center",
        }}
      >
        {/* Left: the brand. It never changes, so it anchors the screen. */}
        <div style={{ width: RAIL_PX, flexShrink: 0 }}>
          <IconCrown size={84} color={GOLD} style={{ filter: `drop-shadow(0 0 26px ${GOLD})` }} />
          <div
            className="tv-eyebrow"
            style={{ color: GOLD_SOFT, fontSize: 26, marginTop: 18, letterSpacing: "0.3em" }}
          >
            Get ready
          </div>
          <div style={{ marginTop: 12 }}>
            {brandWords.map((word, i) => (
              <div
                key={`${word}-${i}`}
                className="tv-display"
                style={{
                  fontSize: railFit(word, i === 0 ? 150 : 88),
                  // ≥1 line-height + a little side padding: gradient-clipped
                  // text with a tight line box slices glyph paint on a scaled
                  // canvas. FIXED px, not em — em padding scales with the font,
                  // so the big "VIP" got nearly twice the indent of
                  // "EXPERIENCE" and the stack read misaligned (owner
                  // 2026-08-11). Every line now shares one left edge.
                  lineHeight: 1.04,
                  padding: "0 8px",
                  whiteSpace: "nowrap",
                  background: `linear-gradient(180deg, #f5ecee 48%, ${GOLD})`,
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                {word}
              </div>
            ))}
          </div>
        </div>

        {/* Right: one tile per party, all on screen together. */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 22 }}>
          {parties.map((vip, i) => (
            <VipTile key={vip.id} vip={vip} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

function bowlingStep(vip: VipEntry): VipStep | null {
  return vip.schedule.find((s) => isBowlingStep(s.label)) ?? null;
}

/** One party: name big, lane unmissable — the welcome board's card, in gold. */
function VipTile({ vip, index }: { vip: VipEntry; index: number }) {
  const step = bowlingStep(vip);
  // "Lanes 1–4", not "Lane 1,2,3,4" — a party big enough to matter holds a
  // run of lanes and the wall should say it the way a person would (owner).
  const laneLabel = formatLanes(step?.lane);
  return (
    <div
      className="tv-glass tv-rise"
      style={{
        position: "relative",
        padding: "26px 34px",
        borderLeft: `8px solid ${GOLD}`,
        // Cascade in, one after another, so the tiles read as arrival.
        animationDelay: `${index * 120}ms`,
        overflow: "hidden",
      }}
    >
      <div
        className="tv-display"
        style={{
          fontSize: 66,
          color: "#fff",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          // Leave air for the lane chip so a long name never runs under it.
          paddingRight: 240,
          textShadow: `0 0 40px ${withAlpha(GOLD, 0.5)}`,
        }}
      >
        {vip.title}
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          gap: 30,
          fontSize: 34,
          color: "rgba(245,236,238,0.78)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
          <IconCrown size={30} color={GOLD} aria-hidden />
          <span>VIP Bowling</span>
        </span>
        {vip.playerCount != null && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            <IconUsersGroup size={32} aria-hidden style={{ opacity: 0.8 }} />
            <span>{vip.playerCount} guests</span>
          </span>
        )}
      </div>

      {laneLabel && (
        <div
          style={{
            position: "absolute",
            right: 28,
            top: "50%",
            transform: "translateY(-50%)",
            padding: "10px 24px",
            borderRadius: 999,
            border: `2px solid ${withAlpha(GOLD, 0.65)}`,
            color: GOLD,
            fontSize: 30,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          {laneLabel}
        </div>
      )}
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
