"use client";

import type { ReactNode } from "react";

/** A `.col` of the board: `.col-h` header, `.col-body`, the prototype's `—` / copy when empty. */
export interface BoardColumnProps {
  header: ReactNode;
  count?: number;
  /** Rendered in `.col-body` when `count === 0`. */
  empty?: ReactNode;
  testId?: string;
  /**
   * A callback ref on the outer `.col`. The queue hands dnd-kit's droppable ref
   * in here so a whole rep column is a drop target; a plain prop rather than
   * `forwardRef` because this repo installs React 18 at the root and 19 inside
   * `apps/web`, and an explicit prop behaves the same in both.
   */
  setRef?: (element: HTMLDivElement | null) => void;
  children: ReactNode;
  style?: React.CSSProperties;
}

export function BoardColumn({
  header,
  count,
  empty,
  testId,
  setRef,
  children,
  style,
}: BoardColumnProps) {
  return (
    <div className="col" data-testid={testId} ref={setRef} style={style}>
      <div className="col-h">{header}</div>
      <div className="col-body">
        {count === 0 ? (
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
