"use client";

/**
 * ONE VERB PER SCREEN — each panel standing over the machine it is talking about.
 *
 * This is the strongest argument against parking the wall's outer TVs on a
 * permanent logo. With all five participating, EVERY kiosk in the bank gets an
 * instruction directly above it: check in · buy a lane · book a race · load a card
 * · buy the VIP night. A guest looking up sees the one sentence that applies to the
 * machine in front of them, not a menu of five things they now have to choose
 * between.
 *
 * The arrow band is the KioskCallout the ad rotation already uses — reused rather
 * than forked, because a fork is how the original stops receiving the next fix. It
 * carries "…on the kiosk below" (owner 2026-08-18): the headline is the WHAT and
 * the band is the WHERE, and without the band a guest reading "Buy a lane" is not
 * actually told that the machine in front of them is how.
 *
 * Note "THE kiosk below", not "any kiosk below" — the ad rotation says *any*
 * because it sells the whole bank, while this board's entire point is that the verb
 * belongs to the one machine directly underneath this panel.
 */
import type { SceneProps } from "../director/types";
import { choreo } from "../wall";
import { howtoPanel, WALL_ACCENT } from "../wall-content";
import { TV_PHOTOS } from "../assets";
import { KioskCallout } from "../components/KioskCallout";
import { WallCard, WallGround } from "../components/WallPanel";

/** The ground under each verb: the thing that verb buys. */
const PANEL_PHOTO = [
  TV_PHOTOS.flag,
  TV_PHOTOS.bowl,
  TV_PHOTOS.race,
  TV_PHOTOS.arcade,
  TV_PHOTOS.vip,
];

/** Height of the arrow band — KioskCallout's own, restated so the card above it
 *  can leave room without guessing. Changing one without the other is how a
 *  headline ends up half-behind a band. */
const CALLOUT_H = 120;

const STAGGER_MS = 130;

// `nowMs` is deliberately not read: this scene is static within its slot, and all
// of its motion (the arrow wave, the light pass) is phase-locked in CSS by
// syncGlowPhase rather than re-rendered on the director's tick.
export function SceneKioskHowto({ config }: SceneProps) {
  const { position } = choreo(config);
  const panel = howtoPanel(position);
  const photo = PANEL_PHOTO[position % PANEL_PHOTO.length];

  // A panel past the end of the verb list carries no instruction — it must not
  // repeat its neighbour's, because the verb names the machine BELOW THIS PANEL
  // and a duplicate would point a guest at the wrong one. It keeps the ground and
  // the band, so the wall still reads as continuous.
  const accent = panel?.accent ?? WALL_ACCENT.cyan;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {/* NO gold hairlines here, even on the VIP verb's panel. The hairlines are
          meant to read as ONE line running the length of the wall; on a single
          panel they are a stub, and gold that appears outside the moments that
          earn it stops meaning All Access. The verb's accent carries it instead. */}
      <WallGround photo={photo} accent={accent} deepScrim />
      {panel && (
        <WallCard
          // Keyed by position so a config change that moves this panel along the
          // wall replays the entrance instead of silently swapping the verb.
          key={`${position}:${panel.verb}`}
          word={panel.verb}
          line={panel.line}
          accent={panel.accent}
          bottomInset={CALLOUT_H + 53}
          delayMs={position * STAGGER_MS}
        />
      )}
      <KioskCallout accent={accent} text={panel?.band ?? "Start at the kiosk below"} />
    </div>
  );
}
