"use client";

/**
 * The TV's clock — the same shared wall clock the kiosks run on.
 *
 * `useKioskClock` is device-agnostic (it just measures an offset against
 * /api/kiosk/now and re-syncs every 5 minutes), so the TV imports it rather
 * than growing a second implementation. That is not incidental reuse: a TV
 * above a bank of kiosks JOINS that bank's billboard choreography, and it can
 * only do that if both are reading the same corrected `Date.now() + offset`.
 */
export { useKioskClock } from "~/features/kiosk/hooks/useKioskClock";
import { syncGlowPhase } from "~/features/kiosk/hooks/useKioskClock";

/**
 * Full-cycle lengths (ms) of every phase-locked CSS animation on the TV canvas.
 * MUST match the declared durations in app/tv/tv.css — a stale entry silently
 * de-syncs that effect between screens (the 2026-07-19 kiosk glow bug, where
 * CSS was retuned to 30s/7.5s while the table still said 26s/7s).
 *
 * `alternate` animations run forward then reverse, so their seekable cycle is
 * 2× the declared duration.
 *
 * Only effects that must agree ACROSS screens belong here. One-shot animations
 * (tv-enter, tv-wipe, tv-rise) are deliberately absent — they are triggered by
 * a scene change that is itself already clock-derived, so seeking them would
 * fight the transition rather than align it.
 */
export const TV_MOTION_PERIODS_MS: Record<string, number> = {
  "tv-kenburns": 60000, // 30s ease-in-out alternate → 60s there-and-back
  "tv-sweep": 7500,
  "tv-neon-flicker": 7000,
  "tv-blink": 1400,
  "tv-chev": 2400,
  "tv-breathe": 2400,
  "tv-drift": 600000, // 10-minute burn-in figure-8
};

/**
 * Seek every phase-locked animation under `root` to the shared clock, so two
 * screens are at the same point in the same effect at the same instant.
 *
 * Delegates to the kiosk's proven implementation (which seeks the running
 * CSSAnimation's currentTime rather than setting a negative animation-delay —
 * see its own note for why a delay cannot phase-align a RUNNING animation).
 * Call on mount, on every scene change, and whenever the clock offset moves.
 */
export function syncTvPhase(root: HTMLElement | null, offset: number): void {
  syncGlowPhase(root, offset, TV_MOTION_PERIODS_MS);
}
