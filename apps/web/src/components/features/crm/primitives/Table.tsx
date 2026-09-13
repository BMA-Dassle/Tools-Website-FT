import type { ReactNode } from "react";

/**
 * `<table class="tbl">` inside the prototype's `.scroll-x` (crm-core.css:228-234)
 * — every table scrolls sideways inside its own container, so a wide one never
 * makes the page scroll horizontally at 390px.
 */
export interface TableColumn {
  key: string;
  label: ReactNode;
  /** Right-aligned tabular numbers. */
  num?: boolean;
  /** Extra classes on the <th>. */
  className?: string;
}

export interface TableProps {
  columns: TableColumn[];
  /** The <tbody> rows. */
  children: ReactNode;
  caption?: string;
  className?: string;
  testId?: string;
}

export function Table({ columns, children, caption, className, testId }: TableProps) {
  return (
    <div className="scroll-x">
      <table className={["tbl", className ?? ""].filter(Boolean).join(" ")} data-testid={testId}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={
                  [c.num ? "num" : "", c.className ?? ""].filter(Boolean).join(" ") || undefined
                }
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
