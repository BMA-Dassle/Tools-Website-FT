"use client";

/**
 * The venue's ACTUAL logo on a wall screen, not its name in type.
 *
 * The welcome board said "Today at HeadPinz" as text; the owner wants the real
 * mark (2026-08-11: "use actual logos"). A logo is also simply better at TV
 * distance than a word — it is recognised rather than read.
 *
 * SAME-ORIGIN AND BUNDLED, deliberately. It reuses KIOSK_LOGOS, which points at
 * `public/brand/*` for a documented reason (features/kiosk/assets.ts): logos never
 * go through the blob host or the image optimizer, because the blob host sits
 * behind a firewall challenge that has blanked venue images before, and a screen
 * whose branding is missing looks broken in a way a missing photo does not.
 *
 * FALLS BACK TO A WORDMARK, never to a broken-image glyph — the same discipline as
 * the kiosk's BrandLogo, which exists because a broken icon did appear on an
 * attract screen (2026-07-24). Not reused directly: that component is keyed by the
 * booking feature's `Brand` and styled with Tailwind classes, while the scenes are
 * keyed by SignageVenue and authored in absolute 1920×1080 pixels.
 */
import { useState } from "react";
import { KIOSK_LOGOS } from "~/features/kiosk/assets";
import type { SignageVenue } from "../constants";

/** FastTrax has its own mark; both HeadPinz venues share theirs. */
function logoFor(venue: SignageVenue): { src: string; word: string } {
  return venue === "FT"
    ? { src: KIOSK_LOGOS.fasttrax, word: "FastTrax" }
    : { src: KIOSK_LOGOS.headpinz, word: "HeadPinz" };
}

export function TvBrandLogo({
  venue,
  height = 72,
}: {
  venue: SignageVenue;
  /** Rendered height in canvas px. Width follows the aspect ratio. */
  height?: number;
}) {
  const [failed, setFailed] = useState(false);
  const { src, word } = logoFor(venue);

  if (failed) {
    return (
      <span className="tv-display" style={{ fontSize: height * 0.62, color: "#fff" }}>
        {word}
      </span>
    );
  }

  return (
    /* Same-origin bundled asset at a fixed canvas height; next/image would add a
       loader and a layout pass for no benefit on a screen whose dimensions never
       change. (The directive must be the LAST line before the element — a
       multi-line comment after it does not attach.) */
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      onError={() => setFailed(true)}
      style={{ height, width: "auto", display: "block", objectFit: "contain" }}
    />
  );
}
