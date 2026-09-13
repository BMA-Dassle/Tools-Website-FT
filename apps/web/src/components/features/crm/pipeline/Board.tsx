"use client";

import type { CrmStatus } from "~/features/crm/core/types";
import type { LeadView } from "~/features/crm/leads/contracts";
import { PIPELINE_TEST_IDS, type BoardColumnView } from "~/features/crm/statuses/contracts";
import { Avatar } from "../primitives/Avatar";
import { Column } from "./Column";
import { DragLayer } from "./DragLayer";
import { KanbanCard } from "./KanbanCard";
import { leadIndex } from "./model";
import { leadTitle } from "../leads/model";
import { useBoardDrag } from "./use-board-drag";

/**
 * The board itself (direction-b.html:70-72). Columns left to right; cards
 * inside, or one lane per rep when the director asks for `?by=rep`.
 *
 * Every card can be MOVED two ways, and both call the same mutation: drag it
 * (pointer events, so a tablet works), or press its "Change status" button and
 * pick from the sheet. The synthetic Booked / Closed columns refuse drops —
 * "Booked" is what a paid deposit means, not something a rep declares — and
 * they visibly dim while a drag is in flight so the refusal is legible before
 * the finger lands, not after.
 */
export interface BoardProps {
  columns: BoardColumnView[];
  leads: LeadView[];
  statuses: Map<string, CrmStatus>;
  byRep: boolean;
  now: Date;
  /** The lead currently being written — its card goes quiet until it settles. */
  pendingLeadId: string | null;
  onOpen: (publicId: string) => void;
  onChangeStatus: (lead: LeadView) => void;
  onMove: (lead: LeadView, toStatusId: string) => void;
}

export function Board({
  columns,
  leads,
  statuses,
  byRep,
  now,
  pendingLeadId,
  onOpen,
  onChangeStatus,
  onMove,
}: BoardProps) {
  const index = leadIndex(leads);
  const droppable = new Set(columns.filter((c) => c.droppable).map((c) => c.id));

  const { drag, cardProps } = useBoardDrag({
    enabled: true,
    canDrop: (id) => droppable.has(id),
    onDrop: (leadId, columnId) => {
      const lead = index.get(leadId);
      if (lead) onMove(lead, columnId);
    },
  });

  const dragged = drag?.active ? index.get(drag.leadId) : undefined;

  const card = (lead: LeadView, columnId: string, hideRep: boolean) => (
    <KanbanCard
      key={lead.id}
      lead={lead}
      status={statuses.get(lead.status)}
      now={now}
      dragProps={cardProps(lead.id, columnId)}
      onOpen={onOpen}
      onChangeStatus={onChangeStatus}
      hideRep={hideRep}
      busy={pendingLeadId === lead.id}
    />
  );

  return (
    <>
      <div className={byRep ? "board grouped" : "board"} data-testid={PIPELINE_TEST_IDS.board}>
        {columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            over={drag?.overColumnId === column.id && drag.fromColumnId !== column.id}
            dragging={!!drag?.active}
            empty={column.droppable ? "—" : emptyCopy(column.id)}
          >
            {column.lanes
              ? column.lanes.map((lane) => (
                  <div key={lane.repId ?? "none"}>
                    <div
                      className="col-rep"
                      data-testid={PIPELINE_TEST_IDS.lane(column.id, lane.repSlug ?? "unassigned")}
                    >
                      <Avatar
                        initials={lane.initials ?? undefined}
                        repSlug={lane.repSlug}
                        name={lane.repName ?? undefined}
                        sm
                      />
                      <span>{lane.repName ?? "Unassigned"}</span>
                      <span className="n">{lane.leadIds.length}</span>
                      {lane.hasOverdue ? (
                        <span className="dot-late" title="has overdue" aria-label="has overdue" />
                      ) : null}
                    </div>
                    {lane.leadIds
                      .map((id) => index.get(id))
                      .filter((l): l is LeadView => !!l)
                      .map((l) => card(l, column.id, true))}
                  </div>
                ))
              : column.leadIds
                  .map((id) => index.get(id))
                  .filter((l): l is LeadView => !!l)
                  .map((l) => card(l, column.id, false))}
          </Column>
        ))}
      </div>
      <DragLayer drag={drag} title={dragged ? leadTitle(dragged) : ""} />
    </>
  );
}

/** The two synthetic columns explain themselves when empty. */
function emptyCopy(columnId: string): string {
  return columnId === "won"
    ? "Nothing booked in this view yet."
    : "Nothing lost — long may it last.";
}
