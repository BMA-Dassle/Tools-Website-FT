"use client";

import { DndContext, type UniqueIdentifier } from "@dnd-kit/core";
import { useState } from "react";
import type { CrmStatus } from "~/features/crm/core/types";
import type { LeadView } from "~/features/crm/leads/contracts";
import { PIPELINE_TEST_IDS, type BoardColumnView } from "~/features/crm/statuses/contracts";
import {
  crmAnnouncements,
  crmCollisionDetection,
  dragInstructions,
  useCrmDragSensors,
} from "../lib/dnd";
import { Avatar } from "../primitives/Avatar";
import { Column } from "./Column";
import { KanbanCard } from "./KanbanCard";
import { leadIndex } from "./model";
import { DragGhost } from "../leads/DragGhost";
import { leadTitle } from "../leads/model";

/**
 * The board itself (direction-b.html:70-72). Columns left to right; cards
 * inside, or one lane per rep when the director asks for `?by=rep`.
 *
 * Every card can be MOVED three ways, and all three call the same mutation:
 * drag it with a mouse, hold and drag it with a finger, or reach it from the
 * keyboard — space on its grab bar, arrow keys, space again. A fourth way,
 * "Change status", is a plain button that never involves a gesture at all
 * (R13: drag is never the only path).
 *
 * The synthetic Booked / Closed columns refuse drops — "Booked" is what a paid
 * deposit means, not something a rep declares — and a card dropped on one does
 * NOTHING, rather than sliding into whichever neighbour would have taken it
 * (see `crmCollisionDetection`).
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
  const sensors = useCrmDragSensors();
  const [drag, setDrag] = useState<{ leadId: string; fromColumnId: string } | null>(null);

  const dragged = drag ? (index.get(drag.leadId) ?? null) : null;

  /** A lead, a column — whatever is in flight, said the way a person says it. */
  const nameOf = (id: UniqueIdentifier) => {
    const key = String(id);
    const lead = index.get(key);
    if (lead) return leadTitle(lead);
    return columns.find((c) => c.id === key)?.label ?? key;
  };

  const card = (lead: LeadView, columnId: string, hideRep: boolean) => (
    <KanbanCard
      key={lead.id}
      lead={lead}
      status={statuses.get(lead.status)}
      now={now}
      columnId={columnId}
      onOpen={onOpen}
      onChangeStatus={onChangeStatus}
      hideRep={hideRep}
      busy={pendingLeadId === lead.id}
    />
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={crmCollisionDetection}
      accessibility={{
        announcements: crmAnnouncements(nameOf),
        screenReaderInstructions: dragInstructions("the pipeline's columns"),
      }}
      onDragStart={({ active }) =>
        setDrag({
          leadId: String(active.id),
          fromColumnId: String(active.data.current?.columnId ?? ""),
        })
      }
      onDragCancel={() => setDrag(null)}
      onDragEnd={({ active, over }) => {
        const from = String(active.data.current?.columnId ?? "");
        setDrag(null);
        if (!over) return;
        const toColumnId = String(over.id);
        if (toColumnId === from) return;
        const lead = index.get(String(active.id));
        if (lead) onMove(lead, toColumnId);
      }}
    >
      <div className={byRep ? "board grouped" : "board"} data-testid={PIPELINE_TEST_IDS.board}>
        {columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            fromColumnId={drag?.fromColumnId ?? null}
            dragging={!!drag}
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
      <DragGhost testId={PIPELINE_TEST_IDS.dragGhost} lead={dragged} />
    </DndContext>
  );
}

/** The two synthetic columns explain themselves when empty. */
function emptyCopy(columnId: string): string {
  return columnId === "won"
    ? "Nothing booked in this view yet."
    : "Nothing lost — long may it last.";
}
