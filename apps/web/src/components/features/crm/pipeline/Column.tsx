"use client";

import type { ReactNode } from "react";
import type { BoardColumnView } from "~/features/crm/statuses/contracts";
import { PIPELINE_TEST_IDS } from "~/features/crm/statuses/contracts";
import { Chip } from "../primitives/Chip";
import { columnSum } from "./model";

/**
 * One `.col` of the pipeline (direction-b.html:71): the status chip, the
 * count, the Σ of the column's values, and the cards.
 *
 * `data-col` is what the drag reads out of the DOM to find its drop target, so
 * it is on the OUTER element and covers the header as well as the body — a
 * card dropped on a column header lands in that column, which is what the
 * gesture looks like it should do.
 *
 * The drop highlight is inline rather than a CSS class: it is two properties
 * on one element, and every other PR in this wave is editing `crm.css`.
 */
export interface ColumnProps {
  column: BoardColumnView;
  /** True while a dragged card is over this column and the drop is allowed. */
  over: boolean;
  /** A drag is in flight somewhere on the board. */
  dragging: boolean;
  empty?: ReactNode;
  children: ReactNode;
}

export function Column({ column, over, dragging, empty, children }: ColumnProps) {
  const sum = columnSum(column);
  const refusing = dragging && !column.droppable;
  return (
    <div
      className="col"
      data-col={column.id}
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
