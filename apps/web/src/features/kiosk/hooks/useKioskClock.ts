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
 *   - CSS glow phase:     `animation-delay: -((Date.now() + offset) % periodMs)ms`
 * so all kiosks stay in lockstep with no per-frame polling.
 *
 * Boot: seed from the last measured offset in localStorage for instant
 * approximate sync, then refine from /api/kiosk/now (a cheap server-time echo)
 * and re-sync on an interval. Offline / fetch failure keeps the cached offset.
 */
export function useKioskClock(): { offset: number; synced: boolean } {
  const [offset, setOffset] = useState(0);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Instant approximate sync from the last measured offset.
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached != null) {
        const n = Number(cached);
        if (Number.isFinite(n)) setOffset(n);
      }
    } catch {
      /* private mode — no cache, refine below */
    }

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
 * CSS animation full-cycle lengths (ms) for the attract glow effects. `alternate`
 * animations run forward then reverse, so their seek-able timeline is 2× the
 * declared duration — see app/kiosk/kiosk.css. Used to phase-align each element
 * via a negative animation-delay so every kiosk is at the same point in the glow.
 */
export const KIOSK_GLOW_PERIODS_MS: Record<string, number> = {
  "kiosk-kenburns": 52000, // 26s ease-in-out alternate → 52s full cycle
  "kiosk-sweep": 7000,
  "kiosk-pulse": 2400,
};

/** Apply the shared clock's phase to every glow element under `root`. */
export function syncGlowPhase(root: HTMLElement | null, offset: number): void {
  if (!root) return;
  const now = Date.now() + offset;
  for (const [cls, period] of Object.entries(KIOSK_GLOW_PERIODS_MS)) {
    root.querySelectorAll<HTMLElement>(`.${cls}`).forEach((el) => {
      el.style.animationDelay = `${-(now % period)}ms`;
    });
  }
}
