"use client";

import { useEffect, useState } from "react";

const CACHE_KEY = "kiosk_clock_offset";
const RESYNC_MS = 5 * 60 * 1000; // correct clock drift every 5 min

/**
 * Shared wall-clock offset so every kiosk agrees on "now" to within a few ms.
 *
 * Returns `{ offset, synced }` where the corrected clock is `Date.now() + offset`.
 * Consumers derive anything that must be identical across devices from it:
 *   - ad-rotation index:  `Math.floor((Date.now() + offset) / slideMs) % n`
 *   - CSS glow phase:     seek each animation to `(Date.now() + offset) % periodMs`
 *     (see syncGlowPhase below)
 * so all kiosks stay in lockstep with no per-frame polling.
 *
 * Boot: seed from the last measured offset in localStorage for instant
 * approximate sync, then refine from /api/kiosk/now (a cheap server-time echo)
 * and re-sync on an interval. Offline / fetch failure keeps the cached offset.
 */
export function useKioskClock(): { offset: number; synced: boolean } {
  // Instant approximate sync: seed from the last measured offset in the state
  // INITIALIZER (not an effect) — the very first glow seek / ad index already
  // uses it. SSR renders with 0; offset never affects markup, so no mismatch.
  const [offset, setOffset] = useState(() => {
    if (typeof window === "undefined") return 0;
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached == null) return 0;
      const n = Number(cached);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0; /* private mode — no cache, refine below */
    }
  });
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const measure = async () => {
      const t0 = Date.now();
      try {
        const res = await fetch("/api/kiosk/now", { cache: "no-store" });
        if (!res.ok) return;
        const { now } = (await res.json()) as { now: number };
        const t1 = Date.now();
        if (cancelled || !Number.isFinite(now)) return;
        // The server stamp corresponds ~to the midpoint of the round trip.
        const localMid = t0 + (t1 - t0) / 2;
        const next = now - localMid;
        setOffset(next);
        setSynced(true);
        try {
          localStorage.setItem(CACHE_KEY, String(Math.round(next)));
        } catch {
          /* non-fatal */
        }
      } catch {
        /* offline — keep the cached/previous offset */
      }
    };

    void measure();
    const iv = setInterval(measure, RESYNC_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  return { offset, synced };
}

/**
 * CSS animation full-cycle lengths (ms) for the attract glow effects. MUST match
 * the declared durations in app/kiosk/kiosk.css — a stale entry silently
 * de-syncs that effect across kiosks (the 2026-07-19 "glow not timing between
 * kiosks" bug: CSS was retuned to 30s/7.5s while this table still said
 * 26s/7s). `alternate` animations run forward then reverse, so their seek-able
 * cycle is 2× the declared duration.
 */
export const KIOSK_GLOW_PERIODS_MS: Record<string, number> = {
  "kiosk-kenburns": 60000, // 30s ease-in-out alternate → 60s there-and-back cycle
  "kiosk-sweep": 7500,
  "kiosk-pulse": 2400,
  "kiosk-racecar": 8000, // one crossing per 8s ad slide (AD_ROTATE_MS)
  "kiosk-bowlball": 8000, // HeadPinz banner ball — same slot as the car

  "kiosk-ad-flicker": 7000, // ad-zone neon headline flicker
  "kiosk-ad-sheen": 4500, // ad-zone banner light sweep
  "kiosk-ad-blink": 1400, // ad-zone banner beacon dots
  "kiosk-ad-rumble": 8000, // banner text rattle — locked to kiosk-racecar
};

/**
 * Seek every glow element under `root` to the shared clock's phase, so all
 * kiosks are at the same point in the glow at the same instant.
 *
 * Seeks the running CSSAnimation's currentTime directly rather than setting a
 * negative animation-delay: a delay only phase-aligns if applied at the exact
 * moment the animation's timeline starts (retiming a RUNNING animation keeps
 * its original start time, so the same delay lands at a different phase), while
 * a currentTime seek is exact whenever it runs — mount, clock resync, or
 * remount. No-op under prefers-reduced-motion (no animations to seek).
 *
 * Per-element stagger: an element may carry data-glow-phase-ms to shift its
 * phase WITHIN the shared cycle (still clock-locked, just offset). Used by the
 * attract race car so the bank of kiosks hands the car off screen-to-screen
 * (highest kiosk number → lowest) instead of every screen animating in unison.
 */
export function syncGlowPhase(root: HTMLElement | null, offset: number): void {
  if (!root) return;
  const now = Date.now() + offset;
  for (const [name, period] of Object.entries(KIOSK_GLOW_PERIODS_MS)) {
    // Class name and @keyframes name match for every glow effect in kiosk.css.
    root.querySelectorAll<HTMLElement>(`.${name}`).forEach((el) => {
      const phaseShift = Number(el.dataset.glowPhaseMs) || 0;
      for (const anim of el.getAnimations()) {
        if (anim instanceof CSSAnimation && anim.animationName === name) {
          anim.currentTime = (now + phaseShift) % period;
        }
      }
    });
  }
}
