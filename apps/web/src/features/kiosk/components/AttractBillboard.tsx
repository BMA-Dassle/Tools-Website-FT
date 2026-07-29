"use client";

/**
 * Bank billboard — the owner-picked HeadPinz attract event (2026-07-26).
 *
 * Every screen in the physical bank takes one activity (real photo + neon
 * word) lighting up left-to-right down the row, then the whole bank lands
 * the line together: "All right here." It reads as one 12-foot billboard
 * and teaches a walk-in the venue's menu in ~8 seconds.
 *
 * Clock-locked: phase comes from the shared wall clock (same offset the ad
 * rotation uses), so all kiosks perform in unison with zero cross-kiosk
 * messaging. A kiosk mid-booking isn't rendering the attract screen at all,
 * so the sequence visually passes "behind" it — no coordination needed.
 *
 * A near-solid navy veil sits under the photo so the base welcome screen
 * (rotating "Let's bowl." etc.) never bleeds through the finale text
 * (owner 2026-07-26: "ALL RIGHT HERE bleeds into the Let's bowl").
 *
 * The whole overlay is pointer-events-none — a tap lands on the welcome
 * zone underneath and starts a session exactly as if the screen were idle.
 */
import { useEffect, useState } from "react";
import {
  BILLBOARD_SLIDES,
  bankPosition,
  bankSize,
  billboardPhase,
  type BillboardPhase,
  type VenueSlug,
} from "../attract/billboard";
import { useResilientImages } from "../hooks/useResilientImage";
import { useT } from "../i18n";

export function AttractBillboard({
  venue,
  kioskNumber,
  offset,
}: {
  venue: VenueSlug;
  kioskNumber: number;
  offset: number;
}) {
  const t = useT();
  const slides = BILLBOARD_SLIDES[venue];
  const count = bankSize(venue);
  // null = this kiosk isn't in the venue's bank map — it sits out of the
  // choreography entirely (owner 2026-07-26) and keeps the normal attract.
  const position = bankPosition(venue, kioskNumber);
  // Positions beyond the slide list reuse the last slide, so an extra
  // mapped screen shows the closing slide instead of a blank takeover.
  const slide =
    position != null && slides.length ? slides[Math.min(position, slides.length - 1)] : null;
  const resolvePhoto = useResilientImages(slides.map((s) => s.photo));

  const [phase, setPhase] = useState<BillboardPhase>("idle");
  useEffect(() => {
    if (position == null) return;
    const tick = () => setPhase(billboardPhase(Date.now() + offset, position, count));
    tick();
    // 200ms poll keeps the phase honest across clock resyncs; the CSS
    // transitions below smooth the edges, so cadence jitter is invisible.
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [offset, position, count]);

  if (!slide) return null;
  const on = phase === "activity";
  const finale = phase === "finale";

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-20">
      {/* navy veil — blanks the base screen so no text-on-text bleed */}
      <div
        className="absolute inset-0 bg-[#000418] transition-opacity duration-500"
        style={{ opacity: on || finale ? 0.94 : 0 }}
      />
      <div
        className="absolute inset-0 bg-cover bg-center transition-opacity duration-500 [filter:saturate(0.85)_brightness(0.9)]"
        style={{
          backgroundImage: `url(${resolvePhoto(slide.photo)})`,
          opacity: on ? 0.9 : finale ? 0.3 : 0,
        }}
      />
      <div
        className="absolute inset-0 transition-opacity duration-500 bg-gradient-to-t from-[#000418]/95 via-[#020a1e]/50 to-[#040a24]/40"
        style={{ opacity: on || finale ? 1 : 0 }}
      />
      {/* activity word */}
      <div
        className="k-display absolute inset-x-0 top-[40%] whitespace-pre-line text-center text-[150px] leading-[0.95] text-white transition-[opacity,transform] duration-500"
        style={{
          opacity: on ? 1 : 0,
          transform: on ? "scale(1)" : "scale(1.55)",
          textShadow: `0 0 10px rgba(255,255,255,0.85), 0 0 64px ${slide.accent}`,
        }}
      >
        {t(slide.word)}
      </div>
      {/* finale — every screen in the bank says it together */}
      <div
        className="k-display absolute inset-x-0 top-[43%] whitespace-pre-line text-center text-[132px] leading-[0.98] text-white transition-[opacity,transform] duration-500"
        style={{
          opacity: finale ? 1 : 0,
          transform: finale ? "scale(1)" : "scale(1.5)",
          textShadow: "0 0 10px rgba(255,255,255,0.9), 0 0 70px #00e2e5",
        }}
      >
        {t("attract.billboard.allRightHere")}
      </div>
    </div>
  );
}
