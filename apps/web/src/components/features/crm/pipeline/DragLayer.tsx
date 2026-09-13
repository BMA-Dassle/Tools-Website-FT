"use client";

import { createPortal } from "react-dom";
import { PIPELINE_TEST_IDS } from "~/features/crm/statuses/contracts";
import { useOverlayRoot } from "../lib/use-crm-user";
import type { DragState } from "./use-board-drag";

/**
 * The card that follows the pointer while a drag is live.
 *
 * It renders through the overlay root — a sibling of the shell — for the same
 * reason every sheet does: `.k-glass`-style ancestors with `transform` or
 * `filter` trap `position: fixed`, and a ghost trapped inside a scrolling
 * column is worse than no ghost at all (lesson 175-222).
 *
 * Styling is inline rather than in `crm.css` on purpose: it is one element,
 * it exists for a few hundred milliseconds, and every other PR in this wave is
 * editing that stylesheet.
 */
export function DragLayer({ drag, title }: { drag: DragState | null; title: string }) {
  const root = useOverlayRoot();
  if (!root || !drag?.active) return null;

  return createPortal(
    <div
      data-testid={PIPELINE_TEST_IDS.dragGhost}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: drag.x + 12,
        top: drag.y + 12,
        zIndex: 60,
        pointerEvents: "none",
        maxWidth: 260,
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid var(--ba-border, #323e53)",
        background: "var(--ba-bg2, #19273e)",
        color: "var(--ba-fg, #f9fafb)",
        boxShadow: "0 12px 28px rgba(0,0,0,.38)",
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {title}
    </div>,
    root,
  );
}
