import { useEffect, useRef } from "react";
import { startVisibleLoop } from "./visible-loop";

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
 * The loop itself lives in ./visible-loop, framework-free and tested there.
 * This hook is the React wiring: the document's visibility, and a ref so the
 * latest callback runs without restarting the loop.
 *
 * Usage:
 *   useVisibleInterval(async (signal) => {
 *     const res = await fetch(url, { signal, cache: "no-store" });
 *     if (signal.aborted) return;
 *     // ... process
 *   }, 20_000, !longPast);
 */

/**
 * THE FLOOR UNDER THE PER-CYCLE WATCHDOG, and the reason there is one at all.
 *
 * "Schedule the next tick only after this one settles" is what stops cycles
 * piling up — and on its own it is also a way for the loop to STOP FOREVER. A
 * `fetch` has no timeout of its own: a stalled connection (a wall panel behind
 * flaky wifi, a NAT that silently drops the flow) leaves the promise pending
 * indefinitely, the await never returns, and nothing ever schedules tick N+1.
 * The page then shows whatever the last good poll said until somebody walks over
 * and reloads it — which is what happened to the FT results wall on 2026-08-17
 * ("kept freezing, I had to refresh several times").
 *
 * Generous on purpose: this is a stall-breaker, not a latency budget. A slow
 * response is still worth having; only a cycle that will never finish is worth
 * abandoning.
 */
const CYCLE_TIMEOUT_FLOOR_MS = 20_000;

export function useVisibleInterval(
  callback: (signal: AbortSignal) => void | Promise<void>,
  delayMs: number,
  enabled: boolean = true,
  /** Cycle deadline. Defaults to twice the cadence, never under
   *  {@link CYCLE_TIMEOUT_FLOOR_MS}. Pass a tighter value on a fast lane where
   *  a stale beat is worse than a missed one. */
  timeoutMs?: number,
): void {
  const latest = useRef(callback);
  latest.current = callback;

  const cycleTimeoutMs = timeoutMs ?? Math.max(delayMs * 2, CYCLE_TIMEOUT_FLOOR_MS);

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return; // SSR safety

    const loop = startVisibleLoop({
      // Through the ref, so a re-render with a new closure does not tear the
      // loop down and restart the cadence.
      run: (signal) => latest.current(signal),
      delayMs,
      timeoutMs: cycleTimeoutMs,
      hiddenAtStart: document.hidden,
    });

    const onVisibility = () => loop.setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      loop.stop();
    };
  }, [delayMs, enabled, cycleTimeoutMs]);
}
