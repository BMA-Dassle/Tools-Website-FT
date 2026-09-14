"use client";

import { DragOverlay } from "@dnd-kit/core";
import { createPortal } from "react-dom";
import { fDate } from "~/features/crm/core/dates";
import { moneyK } from "~/features/crm/core/format";
import type { LeadView } from "~/features/crm/leads/contracts";
import { useOverlayRoot } from "../lib/use-crm-user";
import { centreShort } from "./LeadCard";
import { leadTitle } from "./model";

/**
 * The card that follows the hand while a drag is live — dnd-kit's `DragOverlay`
 * with the CRM's own `.kcard` inside it, so what moves looks like what was
 * picked up rather than a bare label.
 *
 * It renders through the OVERLAY ROOT — a zero-size fixed sibling of the shell —
 * for the same reason every sheet does: the overlay is `position: fixed`, and an
 * ancestor with `transform` or `filter` would make itself its containing block
 * and trap it inside a scrolling column (lesson 175-222). Rendering it through a
 * portal keeps it inside the React tree, so it is still dnd-kit's overlay; it
 * just hangs somewhere the viewport can see it.
 *
 * No control goes in here. The overlay is `aria-hidden` (the real announcements
 * come from dnd-kit's live region) and a focusable element inside an
 * `aria-hidden` subtree is an a11y fault, so this is deliberately a FACSIMILE of
 * the card: title, value, date, guests, centre — and nothing that can be
 * clicked.
 */
export interface DragGhostProps {
  testId: string;
  /** The lead in flight, or null when nothing is being dragged. */
  lead: LeadView | null;
}

export function DragGhost({ testId, lead }: DragGhostProps) {
  const root = useOverlayRoot();
  if (!root) return null;

  return createPortal(
    <DragOverlay zIndex={60} dropAnimation={null}>
      {lead ? (
        <div
          data-testid={testId}
          aria-hidden="true"
          className={`kcard c-${lead.centre}`}
          style={{
            cursor: "grabbing",
            pointerEvents: "none",
            boxShadow: "0 12px 28px rgba(0,0,0,.38)",
            transform: "rotate(1.5deg)",
          }}
        >
          <div className="t">
            <span>{leadTitle(lead)}</span>
            {lead.valueCents ? (
              <span className="money muted">{moneyK(lead.valueCents)}</span>
            ) : null}
          </div>
          <div className="m">
            <span>{fDate(lead.eventDate)}</span>
            <span>{lead.guests} guests</span>
            <span className="muted">{centreShort(lead.centre)}</span>
          </div>
        </div>
      ) : null}
    </DragOverlay>,
    root,
  );
}
