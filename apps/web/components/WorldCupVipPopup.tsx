"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconX, IconBallFootball } from "@tabler/icons-react";
import { modalBackdropProps } from "@/lib/a11y";
import {
  WORLD_CUP_ENDS_AT_MS,
  WORLD_CUP_POPUP_STARTS_AT_MS,
  worldCupEnabledCenters,
  worldCupPopupActive,
} from "~/features/world-cup";

/**
 * World Cup VIP Bowling popup — limited-time (knockout rounds → July 19 final).
 * Mirrors Usa250PromoPopup's lifecycle exactly:
 *   - Renders nothing server-side / before hydration.
 *   - DELAYED START: never shows before 2026-07-05 00:00 ET — the exact instant
 *     the USA250 popup self-expires, so the two promos never stack (owner 7/3).
 *   - Self-expires when the final's window ends; live timers handle a tab that
 *     lingers across either boundary.
 *   - Honors the per-center kill switches (no enabled center → no popup).
 *   - Dismissal remembered per browser session (sessionStorage).
 */
const SESSION_KEY = "world-cup-vip-2026";
const GOLD = "#FFD700";

export default function WorldCupVipPopup({
  // Center-less default: the wizard's center picker asks (owner bug 7/6 —
  // never force fort-myers on a visitor whose center we don't know). The
  // location-page mounts pass their own center-scoped href.
  bookHref = "/book/bowling/v2?experience=world-cup",
}: {
  /** Center-scoped booking link (location-page mounts pass &location=...). */
  bookHref?: string;
}) {
  const [visible, setVisible] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const now = Date.now();
    if (!worldCupPopupActive(now)) {
      // Not yet 7/5, tournament over, or no upcoming matches — maybe arm later.
      if (now >= WORLD_CUP_POPUP_STARTS_AT_MS) return; // over — never show
    }
    if (worldCupEnabledCenters().length === 0) return; // all centers killed
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
    } catch {
      /* sessionStorage blocked (private mode) — show anyway */
    }
    // Before the start instant: arm a timer that flips it on live (a tab left
    // open across midnight 7/4→7/5 starts showing without a refresh).
    const startDelay = Math.max(0, WORLD_CUP_POPUP_STARTS_AT_MS - now);
    const showTimer = setTimeout(
      () => {
        if (worldCupPopupActive(Date.now())) setVisible(true);
      },
      startDelay > 0 ? startDelay : 600,
    );
    // If the tab lingers past the feature end, hide it live without a refresh.
    const expireTimer = setTimeout(
      () => setVisible(false),
      Math.max(0, WORLD_CUP_ENDS_AT_MS - now),
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
        aria-label="World Cup VIP Bowling — watch every match on our LED walls from a VIP lane"
        className="relative w-full max-w-xl overflow-hidden rounded-2xl bg-[#0a1628] shadow-2xl ring-1"
        style={{ borderColor: `${GOLD}55`, boxShadow: `0 0 40px ${GOLD}30` }}
      >
        <button
          ref={closeRef}
          type="button"
          onClick={dismiss}
          aria-label="Dismiss offer"
          className="absolute right-2 top-2 z-10 rounded-full bg-[#0a1628]/90 p-1.5 text-white/80 shadow-lg ring-1 ring-white/15 transition-colors hover:text-white"
        >
          <IconX size={20} stroke={2} />
        </button>

        {/* The real thing: the VIP lanes with the match live on the wall. */}
        <Link href={bookHref} onClick={dismiss} aria-label="Book World Cup VIP Bowling">
          {/* eslint-disable-next-line @next/next/no-img-element -- single promo asset; intrinsic ratio kept */}
          <img
            src="/promo/world-cup/neoverse-vip.jpg"
            alt="World Cup match playing on the giant NeoVerse LED wall above the glow-lit VIP bowling lanes"
            className="block h-auto w-full"
          />
        </Link>

        <div className="p-5 text-center">
          <p
            className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[2.5px]"
            style={{ color: GOLD }}
          >
            <IconBallFootball size={14} /> Knockout rounds · through July 19
          </p>
          <h2 className="font-display text-2xl font-black uppercase italic text-white">
            World Cup VIP Bowling
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/70">
            Watch every match on our massive NeoVerse LED walls from a semi-private VIP lane — 2½
            hours of bowling from kickoff, chips &amp; salsa included. Shoe rental extra.
          </p>
          <p className="mt-2 text-xs text-white/50">
            $112.50/lane Mon–Thu · $137.50/lane Fri–Sun · up to 6 bowlers per lane
          </p>
          <Link
            href={bookHref}
            onClick={dismiss}
            className="mt-4 inline-block rounded-full px-8 py-3 text-sm font-bold uppercase tracking-wider text-[#0a1628] transition-transform hover:scale-[1.03]"
            style={{ backgroundColor: GOLD }}
          >
            Pick Your Match
          </Link>
        </div>
      </div>
    </div>
  );
}
