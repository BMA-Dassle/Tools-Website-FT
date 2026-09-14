"use client";

import { useDraggable } from "@dnd-kit/core";
import { IconFlag } from "@tabler/icons-react";
import type { CrmStatus } from "~/features/crm/core/types";
import type { LeadView } from "~/features/crm/leads/contracts";
import { PIPELINE_TEST_IDS } from "~/features/crm/statuses/contracts";
import { ICON } from "../primitives/icon-props";
import { DragHandle } from "../leads/DragHandle";
import { LeadCard } from "../leads/LeadCard";
import { leadTitle } from "../leads/model";

/**
 * A board card: B3's `LeadCard` (the shared card every screen uses) made
 * draggable and given the TWO extra controls the board needs — a grab bar, and
 * "Change status", which opens the same sheet the deal header does.
 *
 * That second button is not a convenience; it is the reason the board is usable
 * without a mouse (R13 forbids a drag-only interaction). It is a real
 * `<button type="button">` with an `aria-label`, reachable by Tab, and it does
 * exactly what the drag does.
 *
 * The pointer listeners go on the WRAPPER, so the whole card is grabbable; the
 * activator ref goes on the handle, so the keyboard has one unambiguous place
 * to start from and the card's own title button keeps its enter key.
 * `touch-action: manipulation` keeps the column scrolling under a finger that
 * has not held long enough to be dragging.
 */
export interface KanbanCardProps {
  lead: LeadView;
  status: CrmStatus | undefined;
  now: Date;
  /** The column this card is currently in — read back on drop. */
  columnId: string;
  onOpen: (publicId: string) => void;
  onChangeStatus: (lead: LeadView) => void;
  /** The swimlane view already shows the rep in the lane header. */
  hideRep?: boolean;
  busy?: boolean;
}

export function KanbanCard({
  lead,
  status,
  now,
  columnId,
  onOpen,
  onChangeStatus,
  hideRep,
  busy,
}: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: lead.id,
    data: { columnId },
    disabled: busy,
  });

  return (
    <div
      ref={setNodeRef}
      data-testid={PIPELINE_TEST_IDS.card(lead.publicId)}
      data-lead={lead.id}
      style={{ opacity: isDragging ? 0.4 : undefined, touchAction: "manipulation" }}
      {...listeners}
    >
      <LeadCard
        lead={lead}
        status={status}
        now={now}
        onOpen={onOpen}
        hideRep={hideRep}
        quiet={busy}
        extraMeta={
          <>
            <DragHandle
              attributes={attributes}
              setRef={setActivatorNodeRef}
              label={`Move ${leadTitle(lead)} to another column`}
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: "2px 6px" }}
              aria-label={`Change status of ${leadTitle(lead)}`}
              disabled={busy}
              onClick={() => onChangeStatus(lead)}
            >
              <IconFlag {...ICON} /> Change status
            </button>
          </>
        }
      />
    </div>
  );
}
