"use client";

/**
 * Brand logo with a guaranteed non-broken fallback.
 *
 * The source is a BUNDLED, same-origin asset (see KIOSK_LOGOS in ../assets), so
 * it loads whenever the page itself did. If it's ever unavailable anyway, we
 * render a styled text wordmark instead of the browser's broken-image glyph
 * (owner report 2026-07-24: a failed logo fetch left a broken icon on the
 * attract screen). Decorative by default (alt=""); pass a label via `alt` when
 * the logo is the only brand marker on that screen.
 */
import { useState } from "react";
import type { Brand } from "~/features/booking";
import { KIOSK_LOGOS } from "../assets";

export function BrandLogo({
  brand,
  className,
  fallbackClassName,
  alt = "",
  draggable = false,
}: {
  brand: Brand;
  /** Classes for the <img> in the normal (loaded) case. */
  className?: string;
  /** Classes for the text wordmark shown only if the image fails to load.
   *  Defaults to a sensible k-display size; override where the logo is large
   *  (e.g. the attract-screen hero) so the fallback reads at the right scale. */
  fallbackClassName?: string;
  alt?: string;
  draggable?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const name = brand === "headpinz" ? "HeadPinz" : "FastTrax";

  if (failed) {
    return (
      <span className={fallbackClassName ?? "k-display text-[40px] leading-none text-white"}>
        {name}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin bundled asset; no next/image sizing needed
    <img
      src={KIOSK_LOGOS[brand]}
      alt={alt}
      className={className}
      draggable={draggable}
      onError={() => setFailed(true)}
    />
  );
}
