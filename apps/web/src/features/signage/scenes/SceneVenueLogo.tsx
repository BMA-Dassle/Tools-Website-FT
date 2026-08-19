"use client";

/**
 * One brand mark on black. Nothing else.
 *
 * The scene a screen runs BEFORE it has a job. The Old Time Lanes pair at
 * HeadPinz Fort Myers went up ahead of the content that will eventually fill it
 * (owner 2026-08-19, "the only thing they will show is a logo for now"), and the
 * honest answer to that is a deliberate holding card rather than house ads for
 * things nowhere near those lanes.
 *
 * IT TAKES NO FEED, NO SCOPE AND NO VENDOR. That is the design, not an
 * omission: this is the one scene on the estate that cannot be wrong, cannot go
 * stale, and cannot be blanked by a Pandora timeout. It is what `sleep` is for a
 * closed venue — except awake, and branded.
 *
 * TRUE BLACK, not the near-black `sleep` uses. `sleep` is dim on purpose (it is
 * saving a panel overnight and wants to look off); this is a lit sign during
 * trading hours and the owner asked for black, so the mark gets maximum contrast
 * against it. On an OLED that is also a genuinely black surround rather than a
 * grey one.
 *
 * NO ANIMATION, and no burn-in dodge either. Both were considered and neither
 * earns its place: a moving mark on a screen a guest reads at a glance is noise,
 * and these are LCD panels showing a mark whose bright area is a small centred
 * disc — nothing like the static bright bars that actually retain. If a screen
 * on this scene is ever left up for months and starts to ghost, the fix is
 * `sleep` out of hours, which the platform already has.
 */
import Image from "next/image";
import type { SceneProps } from "../director/types";
import { TV_H } from "../constants";
import { logoAsset } from "../logo";

/**
 * How tall the mark is drawn, as a share of the 1080-high canvas.
 *
 * 0.61 puts a 576×636 source at ~659px — a 1.04x upscale, so essentially native.
 * Anything hungrier trades sharpness for size on the estate's one asset whose
 * resolution is fixed by a 2015 scan, and this is already a big confident mark
 * on an otherwise empty screen. Checked on a 1920×1080 composite, not guessed.
 */
const MARK_HEIGHT_FRACTION = 0.61;

export function SceneVenueLogo({ config }: SceneProps) {
  // Already validated by resolveScreenConfig — never null, and never a mark we
  // hold no artwork for, so there is no "no logo picked" state to design.
  const asset = logoAsset(config.venueLogo.mark);

  const height = Math.round(TV_H * MARK_HEIGHT_FRACTION);
  const width = Math.round(height * (asset.width / asset.height));

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Image
        src={asset.src}
        alt=""
        width={width}
        height={height}
        // IN THE FIRST PAINT, not after one. A TV has no scroll and no second
        // chance: a screen that comes up black for a beat after every reload
        // reads as broken to whoever is standing under it. `loading="eager"` plus
        // `fetchPriority="high"` rather than `priority`, which Next 16 deprecated
        // (and rather than `preload`, which its own docs steer away from for
        // exactly this single-known-image case).
        loading="eager"
        fetchPriority="high"
        // UNOPTIMIZED ON PURPOSE, and this is the one place on the estate where
        // that is the right answer — everything else here goes through the
        // optimizer via `tvImg` and should keep doing so.
        //
        // The optimizer has nothing left to give this file and one thing to take
        // away. The asset is already webp with alpha at 576x636, which is the
        // SOURCE resolution — so there is no width to save — and `images.qualities`
        // in next.config.ts is Next 16's default `[75]`, so routing through it
        // would re-encode a quality-92 webp down to 75. That is a second lossy
        // pass, and its artefacts land on hard black lettering over flat white:
        // the worst case for it, on the only image this screen has.
        //
        // The usual reasons to insist on the optimizer also do not apply: this is
        // same-origin under `public/`, so there is no blob firewall challenge to
        // solve, and it is 74KB revalidated by ETag once per page load rather than
        // per-paint egress.
        unoptimized
        style={{ display: "block", width, height, objectFit: "contain" }}
        // Alpha is load-bearing here — the artwork's own white disc is what makes
        // it read on black — so nothing may paint a background behind it.
        draggable={false}
      />
    </div>
  );
}
