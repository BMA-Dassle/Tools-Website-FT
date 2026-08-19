"use client";

/**
 * THE VIP EXPERIENCE, ACROSS FIVE PANELS — four sub-slides, 2m40s.
 *
 * The front-desk wall's anchor scene. Each panel renders ITS SLICE of one
 * composition: the statement, then the three legs of the night, then what is
 * included, then the price. Five panels of the same card would be a hall of
 * mirrors; five panels of one sentence is the reason the wall exists.
 *
 * WHICH SLIDE IS UP COMES FROM THE SHARED CLOCK, never a local counter. 20s
 * divides the 40s slot evenly so a slide can never straddle a boundary, and the
 * scene's 4 slots are two full passes. A panel that reboots mid-showcase rejoins
 * on the same slide as its neighbours, because there is no position to restore.
 *
 * NO SLIDE IS AN ORPHAN. The gold identity rail names the product and its price on
 * every panel of every slide — a guest who walks up during "1.5 hrs VIP bowling"
 * would otherwise be looking at five panels of legs belonging to nothing (owner
 * 2026-08-17). See `identityRail` for why the name and the price each land whole on
 * one panel rather than spanning.
 *
 * GOLD RUNS THROUGHOUT THIS SCENE and nowhere else but the one resting slide,
 * because gold means All Access and a show is when it is on.
 */
import type { SceneProps } from "../director/types";
import { choreo, wallBrand } from "../wall";
import { identityRail, vipSlideIndex, vipSlidePanel, vipWallPrice } from "../wall-content";
import { TV_PHOTOS } from "../assets";
import {
  RAIL_H,
  WallCard,
  WallGround,
  WallIdentityRail,
  WallPoster,
} from "../components/WallPanel";

/**
 * The FALLBACK backdrop per panel, for a slide whose panels carry words rather than
 * things — the statement and the price. Held per POSITION so the ground stays put
 * while the words change, because a picture that cuts every 20 seconds under a
 * changing headline reads as churn.
 *
 * A slide whose panels ARE things overrides this per panel: each of the five parts
 * of the VIP night gets its own picture (owner 2026-08-18), which is what
 * `CardPanel.photo` is for.
 *
 * Deliberately avoids TV_PHOTOS.vipLanes — it has words burned into the frame.
 */
const PANEL_PHOTO = [
  TV_PHOTOS.race,
  TV_PHOTOS.bowl,
  TV_PHOTOS.redTrack,
  TV_PHOTOS.arcade,
  TV_PHOTOS.duck,
];

/** A beat of stagger per panel, so a slide's words light left to right along the
 *  wall — the kiosk bank's own handoff, at wall scale. Well inside the 620ms
 *  tv-rise, so the whole wall has landed within a second of the cut. */
const STAGGER_MS = 130;

export function SceneVipShowcase({ nowMs, config }: SceneProps) {
  const { position, count, gapPct } = choreo(config);
  const slide = vipSlideIndex(nowMs);
  const price = vipWallPrice(nowMs);
  const panel = vipSlidePanel(slide, position, price);
  const rail = identityRail(position, price);
  // The panel's own picture when its subject has one, else the panel's standing
  // ground. Reading it off the content rather than the position is what lets one
  // slide be five things and another be five words.
  const photo =
    (panel?.layout === "card" ? panel.photo : undefined) ??
    PANEL_PHOTO[position % PANEL_PHOTO.length];
  const delayMs = position * STAGGER_MS;
  // WHICH mark this end carries comes from config, falling back to derived-from-
  // the-ends. It has to: which brand goes on which end depends on which way the
  // room faces, and that must be swappable from the admin form rather than by a
  // deploy (plan, open decision 1). Null on an inner panel and on an end whose
  // mark was explicitly silenced.
  const mark = wallBrand(position, count, config.wall?.brand);

  // Keyed by slide so React remounts on every cut and the staggered entrance
  // replays — a sub-slide change is a new frame to the eye, but not to the
  // director (frameKey is the scene name), so the remount has to happen here.
  const key = `${slide}:${position}:${count}`;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <WallGround
        photo={photo}
        accent={panel?.accent ?? "#d4af37"}
        gold
        deepScrim
        wall={{ position, count, gapPct }}
      />

      {panel?.layout === "poster" && (
        <WallPoster
          key={key}
          bigBrand={panel.bigBrand ? mark : null}
          smallBrand={panel.smallBrand}
          // An END panel asked for a brand lockup but given no mark — an explicit
          // "No mark" in the admin form — falls back to naming the product, rather
          // than rendering an empty stack. A blank panel at the end of a wall reads
          // as a dead player, which is the one thing a wall must never fake.
          word={panel.bigBrand && !mark ? "All\nAccess" : panel.word}
          accent={panel.accent}
          rule={panel.rule}
          railed
          delayMs={delayMs}
        />
      )}

      {panel?.layout === "card" && (
        <WallCard
          key={key}
          eyebrow={panel.eyebrow}
          word={panel.word}
          line={panel.line}
          accent={panel.accent}
          bottomInset={RAIL_H + 46}
          delayMs={delayMs}
        />
      )}

      {/* A panel with nothing of its own to say still carries the rail, so the wall
          identifies itself end to end. Nothing renders a placeholder headline: an
          empty gold panel between two full ones reads as part of the design, while
          "—" reads as broken. */}
      {rail && <WallIdentityRail cell={rail} />}
    </div>
  );
}
