"use client";

import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";
import type { BoardColumnView } from "~/features/crm/statuses/contracts";
import { PIPELINE_TEST_IDS } from "~/features/crm/statuses/contracts";
import { Chip } from "../primitives/Chip";
import { columnSum } from "./model";

/**
 * One `.col` of the pipeline (direction-b.html:71): the status chip, the
 * count, the Σ of the column's values, and the cards.
 *
 * The whole column is the drop target — header included, so a card dropped on
 * a column heading lands in that column, which is what the gesture looks like
 * it should do. The synthetic Booked / Closed columns register as DISABLED
 * droppables rather than not registering at all, so dnd-kit can still tell they
 * are there and refuse them; they visibly dim while a drag is in flight so the
 * refusal is legible before the hand lands, not after.
 *
 * The drop highlight is inline rather than a CSS class: it is two properties
 * on one element, and every other PR in this wave is editing `crm.css`.
 */
export interface ColumnProps {
  column: BoardColumnView;
  /** The column the card in flight came from — it does not highlight itself. */
  fromColumnId: string | null;
  /** A drag is in flight somewhere on the board. */
  dragging: boolean;
  empty?: ReactNode;
  children: ReactNode;
}

export function Column({ column, fromColumnId, dragging, empty, children }: ColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: column.id, disabled: !column.droppable });
  const sum = columnSum(column);
  const over = isOver && column.id !== fromColumnId;
  const refusing = dragging && !column.droppable;
  return (
    <div
      ref={setNodeRef}
      className="col"
      data-testid={PIPELINE_TEST_IDS.column(column.id)}
      style={{
        outline: over ? "2px solid var(--acc, #5b8cff)" : undefined,
        outlineOffset: over ? 2 : undefined,
        opacity: refusing ? 0.55 : undefined,
        transition: "opacity .12s ease",
      }}
    >
      <div className="col-h">
        <Chip kind={column.kind} st={column.status?.id}>
          {column.label}
        </Chip>
        <span className="n">{column.count}</span>
        {sum ? <span className="sum">{sum}</span> : null}
      </div>
      <div className="col-body">
        {column.count === 0 ? (
          <div className="empty" style={{ padding: "18px 8px" }}>
            {empty ?? "—"}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
