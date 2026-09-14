"use client";

import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Left / right controls for a horizontally scrolling board.
 *
 * Owner, twice: "I don't like haveing to scroll all the way down on pipeline
 * to scroll right" and then "still had trouble scroll left and right on board
 * I hate scrolling all the way to the bottom first. Can we use arrows or is
 * there better way with the template?"
 *
 * DELIBERATELY ADDITIVE. The board's overflow cascade is not touched by this
 * file. An earlier attempt to fix CRM scrolling by rewriting that cascade
 * shipped on a theory, from a test rig that never reproduced the symptom, and
 * made it worse — the owner's words were "Scroll is f'ed up" and "looks like
 * shit". This works by calling `scrollBy` on whatever element actually
 * scrolls, so it is correct whether or not the scrollbar is where it should
 * be, and it cannot make today's scrolling worse because it changes none of
 * it. If the underlying bar is also misplaced, that is still open and still
 * needs reproducing in a browser before anybody edits the CSS again.
 *
 * Three ways to move the board, because different people reach for different
 * ones: the arrows, a plain mouse wheel (translated to horizontal — a wheel
 * over a horizontal scroller otherwise does nothing at all, which is most of
 * why the board felt stuck), and the arrow keys once a control has focus.
 *
 * The buttons hide rather than disable at each end: a dimmed control still
 * asks to be clicked, and there is nothing to explain at the end of a board.
 */

export interface BoardArrowsProps {
  /** The element that actually scrolls — `.board`, not its wrapper. */
  scroller: RefObject<HTMLElement | null>;
  /** How far one press moves it. Defaults to one column plus its gap. */
  step?: number;
  /** For the buttons' labels: "rep", "stage" → "Scroll left one stage". */
  unit?: string;
}

/** One column (272px) plus the board's 12px gap. */
const DEFAULT_STEP = 284;

export function BoardArrows({ scroller, step = DEFAULT_STEP, unit = "column" }: BoardArrowsProps) {
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;

    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      // A board that does not overflow shows no controls at all: `atEnd` and
      // `atStart` are both true, and both buttons render null.
      setAtStart(el.scrollLeft <= 1);
      setAtEnd(el.scrollLeft >= max - 1);
    };

    // rAF-coalesced: a scroll fires far more often than the two booleans can
    // change, and setState on every frame of a fling is wasted work.
    const onScroll = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        measure();
      });
    };

    /**
     * A vertical wheel over a horizontal scroller does nothing by default,
     * which is most of why the board felt immovable without finding the bar.
     * Translated only when this board can actually scroll sideways and the
     * gesture is not already horizontal (a trackpad's own sideways swipe, and
     * shift+wheel, both arrive as deltaX and are left alone).
     */
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0 || e.shiftKey) return;
      if (el.scrollWidth <= el.clientWidth) return;
      // Don't steal a gesture aimed at a column's own vertical scroller.
      const over = e.target as HTMLElement | null;
      const col = over?.closest?.(".col-body") as HTMLElement | null;
      if (col && col.scrollHeight > col.clientHeight) return;
      e.preventDefault();
      el.scrollBy({ left: e.deltaY, behavior: "auto" });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    // Not passive: translating the gesture requires preventDefault.
    el.addEventListener("wheel", onWheel, { passive: false });
    // `observe` fires the callback once for the element straight away, which
    // IS the first measurement — the board must know on its first paint
    // whether it overflows. No explicit `measure()` call here: it would be a
    // second, identical pass and a setState directly inside the effect.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [scroller]);

  const go = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  // Both true = nothing to scroll. Render neither rather than two dead stubs.
  if (atStart && atEnd) return null;

  return (
    <>
      {atStart ? null : (
        <button
          type="button"
          className="board-arrow left"
          aria-label={`Scroll left one ${unit}`}
          onClick={() => go(-1)}
        >
          <IconChevronLeft size={20} stroke={2} aria-hidden />
        </button>
      )}
      {atEnd ? null : (
        <button
          type="button"
          className="board-arrow right"
          aria-label={`Scroll right one ${unit}`}
          onClick={() => go(1)}
        >
          <IconChevronRight size={20} stroke={2} aria-hidden />
        </button>
      )}
    </>
  );
}
