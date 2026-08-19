import { useEffect, useRef } from "react";

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
 * SIGNAGE OPTS OUT — see setDocumentNeverHidden below. A wall panel that the
 * browser calls hidden is still hanging on a wall being read.
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
      if (pageIsHidden()) return; // belt-and-suspenders; visibility handler also stops the timer
      abortActive();
      const ctrl = new AbortController();
      activeController = ctrl;
      try {
        await latest.current(ctrl.signal);
      } catch {
        /* swallow — caller's problem */
      }
      activeController = null;
      if (cancelled || pageIsHidden()) return;
      // Schedule next tick AFTER the current cycle settled — no overlap.
      timerId = setTimeout(tick, delayMs);
    }

    function onVisibility() {
      if (pageIsHidden()) {
        clearTimer();
        abortActive();
      } else {
        // Run immediately on return — user just refocused, give them
        // fresh data without waiting for the next cadence tick.
        clearTimer();
        tick();
      }
    }

    if (!pageIsHidden()) tick();
    // A document that never reports itself hidden has nothing to listen for,
    // and the handler would restart the cadence on every occlusion flip.
    const watchVisibility = !documentNeverHidden;
    if (watchVisibility) document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (watchVisibility) document.removeEventListener("visibilitychange", onVisibility);
      clearTimer();
      abortActive();
    };
  }, [delayMs, enabled]);
}
