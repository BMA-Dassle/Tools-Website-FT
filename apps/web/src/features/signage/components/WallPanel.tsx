"use client";

/**
 * ONE PANEL OF A VIDEO WALL — the shared ground the front-desk scenes paint on.
 *
 * The whole design is "the wall wears the kiosk attract screen's visual language":
 * the same scrim, the same bloom, the same light pass (see AttractHeadline.tsx and
 * attract/billboard.ts). This component is where that language lives, so the VIP
 * showcase, the menu board and the two wing boards cannot drift apart from each
 * other — five panels that disagree by a few pixels of padding is the one mistake a
 * wall makes visible and a laptop preview hides.
 *
 * AUTHORED IN CANVAS PIXELS. TvStage gives every scene a fixed 1920×1080 canvas
 * that is transform-scaled to the panel, so these are absolute px and not vw/cqw —
 * the design's `cqw` figures are simply px ÷ 19.2. (This is the one place the
 * "size signage type in clamp(vw)" rule does NOT apply: that rule is for scenes
 * laid out in the viewport, and everything here is inside the fixed canvas.)
 *
 * GOLD IS AN EVENT, not a theme. `gold` paints the wash and the two hairlines that
 * read as ONE line running the length of the wall — the move a four-foot gap could
 * never make, and the reason it is reserved for the moments that earn it (the VIP
 * showcase and the one resting slide in five). Gold that were always on would stop
 * meaning All Access, which is the only thing it is allowed to mean.
 *
 * The two headline LAYOUTS that used to live here (the centred poster and the
 * bottom-left card) went with the code-drawn VIP showcase in 2026-09-01: the
 * showcase is exported artwork now, and the menu board owns its own layout because
 * the price is the composition. What is left is the ground they all share.
 */
import { withAlpha } from "../color";
import { wallSpan } from "../wall";
import { WALL_ACCENT } from "../wall-content";

/**
 * `tv-sweep`'s own cycle, from TV_MOTION_PERIODS_MS. Restated here because the
 * per-panel phase offset below is a FRACTION of it — importing the table into a
 * component to read one number would drag the whole motion registry in, and the
 * motion test already pins the table to the stylesheet.
 */
const SWEEP_PERIOD_MS = 7500;

/**
 * DOES THE SHINE TRAVEL ALONG THE WALL, OR LAND ON ALL FIVE AT ONCE?
 *
 * UNISON is the default, and it is what the owner asked for (2026-08-18, three
 * times: "the shine on the 5 TVs is not in sync"). Every panel is seeked to the same
 * phase of the shared clock, so the light crosses all five simultaneously and the
 * wall reads as ONE surface catching the light.
 *
 * A travelling pass was tried first, on a reading of the design's phrase "light
 * wave", and it is the wrong instinct here: staggering the panels is by definition
 * not in sync, and on a wall this tight it reads as five screens disagreeing rather
 * than as one gesture. The mechanism is kept because it is three lines and the kiosk
 * bank genuinely wants it (that is how the attract car hands off screen to screen) —
 * but it is OFF, and turning it on is a deliberate design decision, not a default.
 */
const SWEEP_TRAVELS_ALONG_THE_WALL = false;

/** Whether the travelling pass enters from the right. `tv-sweep` animates
 *  background-position 140% → -60%, so within one panel the band moves right to
 *  left; leading the right-hand panel therefore continues that direction across the
 *  wall. Only consulted when the pass is travelling at all. */
const SWEEP_LEADS_FROM_RIGHT = true;

/**
 * The phase shift for THIS panel's light pass.
 *
 * ZERO in unison mode, which is the default and which is what keeps all five in
 * step: `syncGlowPhase` seeks every panel to `sharedClock % period`, so with no shift
 * they are at the same point in the same 7.5s cycle at the same instant, whatever
 * time each panel happened to boot.
 *
 * Also zero for any screen that is not on a wall, so every existing board is
 * untouched either way.
 */
function sweepPhaseMs(wall: { position: number; count: number; gapPct: number } | null): number {
  if (!SWEEP_TRAVELS_ALONG_THE_WALL) return 0;
  if (!wall || wall.count <= 1) return 0;
  const { start } = wallSpan(wall.position, wall.count, wall.gapPct);
  const fraction = SWEEP_LEADS_FROM_RIGHT ? start : 1 - start;
  return Math.round(fraction * SWEEP_PERIOD_MS);
}

/* ── the ground ───────────────────────────────────────────────────────── */

export function WallGround({
  photo,
  accent,
  gold = false,
  deepScrim = false,
  underArt = false,
  kenburns = false,
  wall = null,
}: {
  photo?: string;
  accent: string;
  /** Paint the gold wash and the wall-long hairlines. */
  gold?: boolean;
  /** The stronger scrim, for a panel carrying 165px type over a busy photo. */
  deepScrim?: boolean;
  /**
   * FULL-FRAME ARTWORK SITS ON THIS GROUND — hold the photograph back evenly
   * instead of burying its bottom half.
   *
   * The scrims above are built for type laid directly on a picture, so they are
   * heaviest exactly where a headline sits. The VIP slides are transparent PNGs
   * whose own artwork already carries that contrast, and the photograph's whole job
   * is to show THROUGH them — a bottom-weighted scrim under one of those hides the
   * half of the picture the design is leaning on. This is flat and even, and darker
   * overall, so the artwork stays the brightest thing on the panel.
   */
  underArt?: boolean;
  kenburns?: boolean;
  /**
   * Where this panel stands, so the light pass travels ALONG the wall instead of
   * every panel glinting at once. Null (or absent) on a screen that is not part of
   * a wall, which keeps every existing board exactly as it is.
   */
  wall?: { position: number; count: number; gapPct: number } | null;
}) {
  return (
    <>
      {photo && (
        /* Overdrawn 6% so a ken-burns pan can never reveal an edge — the same
           inset SceneAdRotation uses, for the same reason. */
        <div
          aria-hidden
          className={kenburns ? "tv-kenburns" : undefined}
          style={{
            position: "absolute",
            inset: "-6%",
            backgroundImage: `url(${photo})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: underArt
              ? "saturate(0.75) brightness(0.58)"
              : "saturate(0.78) brightness(0.82)",
          }}
        />
      )}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: underArt
            ? "rgba(2,8,30,0.42)"
            : deepScrim
              ? "linear-gradient(to top, #000418 6%, rgba(2,10,34,0.88) 46%, rgba(4,14,44,0.5))"
              : "linear-gradient(to top, #000418 8%, rgba(2,10,34,0.80) 55%, rgba(4,14,44,0.6))",
        }}
      />
      {underArt && (
        /* Just enough weight at the very top and bottom to seat the artwork on the
           panel — without it the picture runs to the bezel and the gold hairlines
           lose the dark they are drawn against. */
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(to top, rgba(0,4,24,0.85), rgba(0,4,24,0.1) 45%, rgba(0,4,24,0.35))",
          }}
        />
      )}
      {/* The activity's own colour, pooled behind where the headline sits. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(62% 38% at 50% 30%, ${withAlpha(accent, 0.22)}, transparent 68%)`,
        }}
      />
      {gold && (
        <>
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background: `linear-gradient(to top, ${withAlpha(WALL_ACCENT.vip, 0.2)}, transparent 62%)`,
              mixBlendMode: "soft-light",
            }}
          />
          <GoldHairline edge="top" />
          <GoldHairline edge="bottom" />
        </>
      )}
      {/* ONE LIGHT PASS ALONG THE WHOLE WALL.
          Phase-locked to the shared clock by syncGlowPhase, and offset per panel by
          where that panel stands on the virtual canvas — WITHOUT the offset all five
          glint at the same instant, which is synchronised but is not a wave. This is
          the same `data-glow-phase-ms` mechanism the kiosk bank uses to hand its
          attract car from screen to screen. */}
      <div
        aria-hidden
        className="tv-sweep"
        data-glow-phase-ms={sweepPhaseMs(wall)}
        style={{ position: "absolute", inset: 0 }}
      />
    </>
  );
}

/** A hairline that, at six inches of gap, reads as one gold line running the
 *  length of the wall. Faded at both ends so panel-to-panel joins are not visible
 *  as bright seams. */
function GoldHairline({ edge }: { edge: "top" | "bottom" }) {
  const g = WALL_ACCENT.vip;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        [edge]: 0,
        height: 4,
        background: `linear-gradient(90deg, ${withAlpha(g, 0.15)}, ${g} 22%, ${g} 78%, ${withAlpha(g, 0.15)})`,
        boxShadow: `0 0 27px ${withAlpha(g, 0.55)}`,
        zIndex: 3,
      }}
    />
  );
}
