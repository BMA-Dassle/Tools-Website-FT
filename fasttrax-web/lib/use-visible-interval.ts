import { useEffect, useRef } from "react";

/**
 * Run an async callback on a fixed cadence, but ONLY while the
 * document is visible. Hidden tab → no fetches. Tab refocused →
 * immediate refresh + cadence resumes.
 *
 * Why: long-lived ticket pages (`/t/[id]`, `/g/[id]`) sat in
 * background tabs polling Pandora every 20s. Edge in particular
 * eventually killed the renderer for hitting the per-tab memory cap,
 * and the user saw "This page couldn't load" on next focus. Pausing
 * when hidden cuts per-tab work to zero while the page isn't being
 * looked at.
 *
 * Cadence pattern: `setTimeout`-recursive, NOT `setInterval`. The
 * next tick only schedules after the current cycle completes —
 * eliminates the overlap-pile-up failure mode where slow Pandora
 * responses cause cycle-N+1 to fire before cycle-N has settled,
 * leaving promises stacking up.
 *
 * Cancellation: each cycle gets its own AbortSignal which is passed
 * to the callback. If the tab is hidden (or the component unmounts)
 * mid-cycle, the in-flight fetches abort cleanly. Callers should
 * forward `signal` to their `fetch(url, { signal })` calls.
 *
 * Usage:
 *   useVisibleInterval(async (signal) => {
 *     const res = await fetch(url, { signal, cache: "no-store" });
 *     if (signal.aborted) return;
 *     // ... process
 *   }, 20_000, !longPast);
 */
export function useVisibleInterval(
  callback: (signal: AbortSignal) => void | Promise<void>,
  delayMs: number,
  enabled: boolean = true,
): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return; // SSR safety

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    function clearTimer() {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    }
    function abortActive() {
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
    }

    async function tick() {
      if (cancelled) return;
      if (document.hidden) return; // belt-and-suspenders; visibility handler also stops the timer
      abortActive();
      const ctrl = new AbortController();
      activeController = ctrl;
      try {
        await latest.current(ctrl.signal);
      } catch { /* swallow — caller's problem */ }
      activeController = null;
      if (cancelled || document.hidden) return;
      // Schedule next tick AFTER the current cycle settled — no overlap.
      timerId = setTimeout(tick, delayMs);
    }

    function onVisibility() {
      if (document.hidden) {
        clearTimer();
        abortActive();
      } else {
        // Run immediately on return — user just refocused, give them
        // fresh data without waiting for the next cadence tick.
        clearTimer();
        tick();
      }
    }

    if (!document.hidden) tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimer();
      abortActive();
    };
  }, [delayMs, enabled]);
}
