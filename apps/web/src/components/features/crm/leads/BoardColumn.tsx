"use client";

import type { ReactNode } from "react";

/** A `.col` of the board: `.col-h` header, `.col-body`, the prototype's `—` / copy when empty. */
export interface BoardColumnProps {
  header: ReactNode;
  count?: number;
  /** Rendered in `.col-body` when `count === 0`. */
  empty?: ReactNode;
  testId?: string;
  children: ReactNode;
  style?: React.CSSProperties;
}

export function BoardColumn({ header, count, empty, testId, children, style }: BoardColumnProps) {
  return (
    <div className="col" data-testid={testId} style={style}>
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
