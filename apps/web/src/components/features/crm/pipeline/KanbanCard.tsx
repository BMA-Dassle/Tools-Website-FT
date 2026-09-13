"use client";

import { IconFlag } from "@tabler/icons-react";
import type { CrmStatus } from "~/features/crm/core/types";
import type { LeadView } from "~/features/crm/leads/contracts";
import { PIPELINE_TEST_IDS } from "~/features/crm/statuses/contracts";
import { ICON } from "../primitives/icon-props";
import { LeadCard } from "../leads/LeadCard";
import { leadTitle } from "../leads/model";
import type { DragCardProps } from "./use-board-drag";

/**
 * A board card: B3's `LeadCard` (the shared card every screen uses) wrapped in
 * the drag gesture and given the ONE extra control the board needs — "Change
 * status", which opens the same sheet the deal header does.
 *
 * That button is not a convenience; it is the reason the board is usable
 * without a mouse (R13 forbids a drag-only interaction). It is a real
 * `<button type="button">` with an `aria-label`, reachable by Tab, and it does
 * exactly what the drag does.
 */
export interface KanbanCardProps {
  lead: LeadView;
  status: CrmStatus | undefined;
  now: Date;
  dragProps: DragCardProps;
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
  dragProps,
  onOpen,
  onChangeStatus,
  hideRep,
  busy,
}: KanbanCardProps) {
  const { style, ...handlers } = dragProps;
  return (
    <div
      data-testid={PIPELINE_TEST_IDS.card(lead.publicId)}
      data-lead={lead.id}
      style={style}
      {...handlers}
    >
      <LeadCard
        lead={lead}
        status={status}
        now={now}
        onOpen={onOpen}
        hideRep={hideRep}
        quiet={busy}
        extraMeta={
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
        }
      />
    </div>
  );
}
