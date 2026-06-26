"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconX } from "@tabler/icons-react";
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
 * The coupon art is the supplied PNG at `public/promo/usa250-july4.png` (served
 * at /promo/usa250-july4.png). Clicking the coupon (or the button) books with
 * the code pre-applied.
 */
const EXPIRES_AT_MS = Date.parse("2026-07-05T00:00:00-04:00"); // end of July 4 ET (00:00 EDT Jul 5)
const SESSION_KEY = "usa250-july4-2026";
const COUPON_SRC = "/promo/usa250-july4.png";

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

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      {...modalBackdropProps(dismiss)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="July 4th — 25% off all reservations with code USA250"
        className="relative w-full max-w-xl"
      >
        <button
          ref={closeRef}
          type="button"
          onClick={dismiss}
          aria-label="Dismiss offer"
          className="absolute -right-2 -top-2 z-10 rounded-full bg-[#0a1628] p-1.5 text-white/80 shadow-lg ring-1 ring-white/15 transition-colors hover:text-white"
        >
          <IconX size={20} stroke={2} />
        </button>

        {/* The supplied coupon graphic — clicking it books with USA250 applied. */}
        <Link href={bookHref} onClick={dismiss} aria-label="Book July 4th with 25% off">
          {/* eslint-disable-next-line @next/next/no-img-element -- single decorative promo asset; intrinsic ratio kept */}
          <img
            src={COUPON_SRC}
            alt="1776 Prices, 2026 Quality — 25% off all reservations July 4th. Use code USA250."
            className="block h-auto w-full rounded-2xl shadow-2xl"
          />
        </Link>

        <Link
          href={bookHref}
          onClick={dismiss}
          className="mx-auto mt-4 block w-max rounded-full bg-[#e23b3f] px-8 py-3 text-center text-base font-bold uppercase tracking-wider text-white transition-transform hover:scale-[1.02]"
        >
          Book July 4th →
        </Link>
      </div>
    </div>
  );
}
