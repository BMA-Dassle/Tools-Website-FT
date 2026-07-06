"use client";

import { useEffect, useRef, useState } from "react";
import { Fireworks } from "fireworks-js";

/**
 * July4Fireworks — full-viewport fireworks overlay for the Fourth of July.
 *
 * Mounted on each center's home page (FastTrax home, HeadPinz home, HeadPinz
 * Fort Myers, HeadPinz Naples). Renders nothing except on July 4th (visitor's
 * local date — both brands are single-timezone SWFL), so it can ship ahead of
 * the holiday and turn itself on/off without a deploy.
 *
 * - `?fireworks=1` forces it on any day, for smoke-testing before the 4th.
 * - Honors `prefers-reduced-motion` (skipped entirely).
 * - `pointer-events-none` + z-40: floats above page content but below the
 *   fixed nav (z-50) and the USA250 promo popup (z-[120]).
 *
 * fireworks-js colors each explosion from a hue band, so red/white/blue comes
 * from rotating bands every few seconds — "white" is any hue at near-max
 * brightness (HSL lightness ≈ 100 reads white regardless of hue).
 */

const VOLLEYS = [
  { hue: { min: 0, max: 14 }, brightness: { min: 52, max: 68 } }, // red
  { hue: { min: 0, max: 360 }, brightness: { min: 92, max: 100 } }, // white
  { hue: { min: 212, max: 244 }, brightness: { min: 52, max: 68 } }, // blue
];

const VOLLEY_ROTATE_MS = 3200;

function isJulyFourth(): boolean {
  const now = new Date();
  return now.getMonth() === 6 && now.getDate() === 4;
}

export default function July4Fireworks() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);

  // Gate needs client-only signals (local date, media query, URL), so it runs
  // in an effect; SSR and non-holiday visits render nothing.
  useEffect(() => {
    const preview = new URLSearchParams(window.location.search).has("fireworks");
    if (!preview) {
      if (!isJulyFourth()) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time client-only holiday gate
    setActive(true);
  }, []);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    const fireworks = new Fireworks(containerRef.current, {
      ...VOLLEYS[0],
      // Light show, not a barrage — 75% of traffic is mobile.
      intensity: 16,
      explosion: 6,
      particles: 55,
      traceSpeed: 12,
      rocketsPoint: { min: 15, max: 85 },
      acceleration: 1.02,
    });
    fireworks.start();

    let volley = 0;
    const rotate = setInterval(() => {
      volley = (volley + 1) % VOLLEYS.length;
      fireworks.updateOptions(VOLLEYS[volley]);
    }, VOLLEY_ROTATE_MS);

    return () => {
      clearInterval(rotate);
      fireworks.stop(true);
    };
  }, [active]);

  if (!active) return null;

  return <div ref={containerRef} aria-hidden className="pointer-events-none fixed inset-0 z-40" />;
}
