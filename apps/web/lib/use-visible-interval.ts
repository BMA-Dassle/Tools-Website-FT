import { useEffect, useRef } from "react";
import { startVisibleLoop } from "./visible-loop";

/**
 * DOES THIS DOCUMENT TELL THE TRUTH ABOUT BEING HIDDEN?
 *
 * On every page a person is looking at, `document.hidden` means what it says
 * and pausing is right. On a TV PLAYER IT IS A LIE: Edge reports a fullscreen
 * wall panel as hidden whenever Windows decides its window is occluded or
 * backgrounded — a second window on the same machine, a focus steal, a display
 * that renegotiated — and the panel goes on hanging there in front of guests
 * showing whatever it last painted.
 *
 * WHAT THAT COST (owner 2026-08-19: the five HeadPinz front-desk screens "are
 * showing offline in admin but they're online and working"). Their heartbeat is
 * written by the feed poll, so a paused poll reads as a dead screen in admin —
 * and, far worse than the dot, the wall itself was frozen on a feed minutes or
 * hours old while looking perfectly healthy. HPFM:2/4/5 had not polled inside
 * the 15-minute heartbeat TTL at all; HPFM:3 and HPFM:6 had managed exactly one
 * poll each, a second apart, and then stopped — the signature of a visibility
 * flip, not of a crash or a network outage.
 *
 * PAGE-WIDE, NOT PER-CALL, deliberately. A dozen hooks across five scenes poll
 * on a TV, and threading an option through each one means the next scene added
 * quietly gets the broken behaviour back. The lie is a property of the
 * DOCUMENT, so it is answered once, for the document.
 *
 * Called at MODULE SCOPE by the TV app, not in an effect: React runs child
 * effects before the parent's, so a parent effect would set this after the
 * first round of polls had already been scheduled the wrong way.
 */
let documentNeverHidden = false;

export function setDocumentNeverHidden(value: boolean): void {
  documentNeverHidden = value;
}

/** Exported for the test. `document` is absent under SSR and in node-env tests;
 *  neither can be hidden, so both answer false. */
export function pageIsHidden(): boolean {
  if (documentNeverHidden) return false;
  return typeof document !== "undefined" && document.hidden;
}

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
 * SIGNAGE OPTS OUT — see setDocumentNeverHidden above. A wall panel that the
 * browser calls hidden is still hanging on a wall being read.
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
      // THROUGH pageIsHidden, NEVER document.hidden directly — a wall panel
      // reports itself hidden the moment Windows occludes it, and starting the
      // loop paused there is how a screen came up dead in front of guests.
      hiddenAtStart: pageIsHidden(),
    });

    // A DOCUMENT THAT NEVER REPORTS ITSELF HIDDEN HAS NOTHING TO LISTEN FOR.
    //
    // Worth being explicit about, because the two faults this file has carried
    // meet here. The loop now supersedes a cycle in flight rather than running
    // beside it, so a visibility flap can no longer FORK it — but on a TV the
    // flap is noise in the first place, and the cheapest correct thing is not to
    // subscribe. On every other page the listener is exactly right and stays.
    if (documentNeverHidden) {
      return () => loop.stop();
    }

    const onVisibility = () => loop.setHidden(pageIsHidden());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      loop.stop();
    };
  }, [delayMs, enabled, cycleTimeoutMs]);
}
