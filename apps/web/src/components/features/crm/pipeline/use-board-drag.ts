"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DRAG_THRESHOLD_PX, columnIdAtPoint } from "./model";

/**
 * Card drag, on POINTER events — mouse, pen and touch through one code path,
 * which HTML5 drag-and-drop does not give us on a phone or an iPad, and the
 * planners work from both.
 *
 * It is NEVER the only way to move a card (R13: no drag-only interaction).
 * Every card also carries a "Change status" button that opens the same sheet
 * and calls the same mutation; this hook only makes the direct manipulation
 * work for people who reach for it.
 *
 * Mechanics worth knowing:
 *   • a press becomes a drag only after `DRAG_THRESHOLD_PX` of travel, so a
 *     tap still opens the deal and a scroll still scrolls;
 *   • the pointer is CAPTURED on the card, so the gesture survives the pointer
 *     leaving the card — including over a different column;
 *   • `touch-action: none` is set on the card only WHILE dragging, so vertical
 *     scrolling in a column is unaffected the rest of the time;
 *   • the drop target is read from the DOM (`[data-col]`) rather than from
 *     React state, so a column that scrolled under the finger is still found;
 *   • Escape cancels, and so does a pointercancel from the browser.
 */

export interface DragState {
  leadId: string;
  fromColumnId: string;
  /** Viewport coordinates of the pointer — the ghost follows these. */
  x: number;
  y: number;
  /** The column under the pointer right now, or null. */
  overColumnId: string | null;
  /** False until the pointer has travelled far enough to be a drag. */
  active: boolean;
}

export interface BoardDragOptions {
  /** Which column ids accept a drop (the synthetic Booked / Closed do not). */
  canDrop: (columnId: string) => boolean;
  onDrop: (leadId: string, columnId: string) => void;
  enabled: boolean;
}

/** What a card spreads onto its root element — the whole gesture in one object. */
export interface DragCardProps {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  style: React.CSSProperties | undefined;
}

export interface BoardDrag {
  drag: DragState | null;
  cardProps: (leadId: string, columnId: string) => DragCardProps;
  cancel: () => void;
}

export function useBoardDrag(options: BoardDragOptions): BoardDrag {
  const [drag, setDrag] = useState<DragState | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const captured = useRef<{ el: Element; pointerId: number } | null>(null);
  // The latest-ref pattern: the pointer handlers are installed once per card
  // but must always call the CURRENT `onDrop` / `canDrop`. Written in an
  // effect, never during render (react-hooks/refs) — effects run before a
  // human can start a gesture on the painted frame.
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });

  const release = useCallback(() => {
    const held = captured.current;
    if (held && "releasePointerCapture" in held.el) {
      try {
        (held.el as HTMLElement).releasePointerCapture(held.pointerId);
      } catch {
        // The element may already be gone (a re-render mid-gesture); harmless.
      }
    }
    captured.current = null;
    origin.current = null;
  }, []);

  const cancel = useCallback(() => {
    release();
    setDrag(null);
  }, [release]);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag, cancel]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    setDrag((cur) => {
      if (!cur) return cur;
      const start = origin.current;
      const moved =
        cur.active ||
        (!!start && Math.hypot(e.clientX - start.x, e.clientY - start.y) >= DRAG_THRESHOLD_PX);
      if (!moved) return cur;
      const over = columnIdAtPoint(e.clientX, e.clientY);
      return {
        ...cur,
        active: true,
        x: e.clientX,
        y: e.clientY,
        overColumnId: over && opts.current.canDrop(over) ? over : null,
      };
    });
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const cur = drag;
      release();
      setDrag(null);
      if (!cur?.active) return;
      const over = columnIdAtPoint(e.clientX, e.clientY);
      if (!over || over === cur.fromColumnId || !opts.current.canDrop(over)) return;
      opts.current.onDrop(cur.leadId, over);
    },
    [drag, release],
  );

  const cardProps = useCallback(
    (leadId: string, columnId: string): DragCardProps => ({
      onPointerMove,
      onPointerUp,
      onPointerCancel: cancel,
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (!opts.current.enabled) return;
        // Primary button / single touch only, and never from a control inside
        // the card — the rail buttons and the title link stay clickable.
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
        const el = e.currentTarget;
        try {
          el.setPointerCapture(e.pointerId);
          captured.current = { el, pointerId: e.pointerId };
        } catch {
          captured.current = null;
        }
        origin.current = { x: e.clientX, y: e.clientY };
        setDrag({
          leadId,
          fromColumnId: columnId,
          x: e.clientX,
          y: e.clientY,
          overColumnId: null,
          active: false,
        });
      },
      style:
        drag?.leadId === leadId && drag.active
          ? ({ opacity: 0.4, touchAction: "none" } as React.CSSProperties)
          : undefined,
    }),
    [drag, onPointerMove, onPointerUp, cancel],
  );

  // Move / up / cancel ride on the card itself because the pointer is captured
  // there: the gesture keeps reporting to the card even over another column.
  return { drag, cardProps, cancel };
}
