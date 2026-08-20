"use client";

/**
 * Measure once whether this board is filling its monitor, and let both consumers
 * read it: the staff stamp on the glass, and the heartbeat on the wire.
 *
 * The rule it applies — and in particular why this cannot be
 * `document.fullscreenElement` — lives in fullscreen.ts. This file is only the
 * DOM half: when to measure, and how the answer reaches the poll.
 *
 * WHY THE POLL READS IT THROUGH A MODULE-SCOPE GETTER instead of a prop or a
 * hook dependency. `useTvFeed` owns the loop that three separate fixes went into
 * last night — a stall deadline, a single live generation, no pause on a lying
 * `document.hidden`. Adding a value to that hook's dependency array puts a new
 * way to tear down and restart the loop into the one place in this codebase where
 * that has already gone wrong three times. A getter read at FETCH time cannot:
 * the flag rides whatever request happens next and changes nothing about when
 * requests happen. Same shape, and the same reasoning, as
 * `setDocumentNeverHidden` in lib/use-visible-interval.ts.
 */
import { useEffect, useState } from "react";
import { fillsPanel } from "./fullscreen";

/** Last measured answer, for the poll to attach. Defaults to "filling", so a
 *  board that has not measured yet never reports a fault it has not seen. */
let windowedNow = false;

/** Read at fetch time by useTvFeed. Not React state on purpose — see above. */
export function isPanelWindowed(): boolean {
  return windowedNow;
}

/**
 * True when this board is NOT filling its monitor.
 *
 * Re-measures on resize, on visualViewport resize, and on fullscreenchange —
 * between them those cover entering or leaving fullscreen, a window being moved
 * to another monitor, and a resolution change on the panel itself.
 */
export function usePanelFill(): boolean {
  const [windowed, setWindowed] = useState(false);

  useEffect(() => {
    const measure = () => {
      const fills = fillsPanel({
        innerW: window.visualViewport?.width ?? window.innerWidth,
        innerH: window.visualViewport?.height ?? window.innerHeight,
        screenW: window.screen?.width ?? 0,
        screenH: window.screen?.height ?? 0,
      });
      windowedNow = !fills;
      // Only re-render when the answer actually changes. A resize on a wall
      // panel is rare, but the visualViewport listener also fires on scroll-ish
      // events on some engines and this page must not re-render for nothing.
      setWindowed((prev) => (prev === !fills ? prev : !fills));
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("fullscreenchange", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("fullscreenchange", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);

  return windowed;
}
