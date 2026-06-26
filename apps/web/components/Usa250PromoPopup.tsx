"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconStarFilled, IconX } from "@tabler/icons-react";
import { modalBackdropProps } from "@/lib/a11y";

/**
 * July-4 "USA250" promo popup — 25% off all reservations for a July-4-2026 visit.
 * Shown on every center home page (FastTrax FM, HeadPinz picker + Fort Myers +
 * Naples). Mirrors EventClosurePopup's lifecycle:
 *   - Renders nothing server-side / before hydration.
 *   - Self-expires at the instant the promo ends (end of July 4 ET) — no manual
 *     takedown. If a tab lingers past it, a timer hides it live.
 *   - Dismissal remembered per browser session (sessionStorage), so it informs a
 *     returning visitor without nagging within one session.
 *
 * Patriotic coupon art recreated in CSS (no image asset): "1776 Prices · 2026
 * Quality", a star row, the "25% OFF ALL RESERVATIONS" band, and the USA250 code.
 */
const EXPIRES_AT_MS = Date.parse("2026-07-05T00:00:00-04:00"); // end of July 4 ET (00:00 EDT Jul 5)
const SESSION_KEY = "usa250-july4-2026";

const NAVY = "#1c3a6e";
const RED = "#e23b3f";
const CREAM = "#ece3d0";

export default function Usa250PromoPopup({
  bookHref = "/book/v2?code=USA250",
}: {
  /** Center-scoped booking link (Naples passes &location=naples). */
  bookHref?: string;
}) {
  const [visible, setVisible] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (Date.now() >= EXPIRES_AT_MS) return; // promo over — never show
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
    } catch {
      /* sessionStorage blocked (private mode) — show anyway */
    }
    const showTimer = setTimeout(() => setVisible(true), 600);
    // If the tab lingers past the promo end, hide it live without a refresh.
    const expireTimer = setTimeout(
      () => setVisible(false),
      Math.max(0, EXPIRES_AT_MS - Date.now()),
    );
    return () => {
      clearTimeout(showTimer);
      clearTimeout(expireTimer);
    };
  }, []);

  useEffect(() => {
    if (visible) closeRef.current?.focus();
  }, [visible]);

  if (!visible) return null;

  function dismiss() {
    setVisible(false);
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  const stars: string[] = [NAVY, NAVY, NAVY, NAVY, NAVY, RED, RED, RED, RED, RED];

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      {...modalBackdropProps(dismiss)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="usa250-title"
        className="relative w-full max-w-lg overflow-hidden rounded-2xl shadow-2xl"
        style={{ backgroundColor: CREAM, boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
      >
        <button
          ref={closeRef}
          type="button"
          onClick={dismiss}
          aria-label="Dismiss offer"
          className="absolute right-3 top-3 rounded-full p-1.5 transition-colors hover:bg-black/10"
          style={{ color: NAVY }}
        >
          <IconX size={20} stroke={2} />
        </button>

        <div className="px-6 py-8 text-center sm:px-10">
          <h2
            id="usa250-title"
            className="font-display text-3xl font-black uppercase italic leading-none sm:text-4xl"
          >
            <span style={{ color: NAVY }}>1776 Prices</span>{" "}
            <span style={{ color: RED }}>2026 Quality</span>
          </h2>

          <div className="mt-3 flex items-center justify-center gap-1.5">
            {stars.map((c, i) => (
              <IconStarFilled key={i} size={15} style={{ color: c }} />
            ))}
          </div>

          <div className="mt-6 -rotate-1 py-2.5" style={{ backgroundColor: RED }}>
            <p
              className="font-display text-2xl font-black uppercase italic tracking-wide sm:text-3xl"
              style={{ color: CREAM }}
            >
              25% Off All Reservations
            </p>
          </div>

          <div
            className="mx-auto mt-6 inline-block border-2 px-7 py-3"
            style={{ borderColor: RED }}
          >
            <p className="text-[11px] font-bold uppercase tracking-[3px]" style={{ color: NAVY }}>
              Use Code
            </p>
            <p
              className="font-display text-3xl font-black uppercase tracking-wider"
              style={{ color: NAVY }}
            >
              USA250
            </p>
          </div>

          <p className="mt-4 text-sm font-semibold" style={{ color: NAVY }}>
            Valid July 4, 2026 only · book online
          </p>

          <Link
            href={bookHref}
            onClick={dismiss}
            className="mt-6 block rounded-full px-6 py-3.5 text-center text-base font-bold uppercase tracking-wider transition-transform hover:scale-[1.02]"
            style={{ backgroundColor: NAVY, color: CREAM }}
          >
            Book July 4th →
          </Link>
        </div>
      </div>
    </div>
  );
}
