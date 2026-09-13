import type { ReactNode } from "react";

/**
 * `<dl class="kv">` (crm-core.css:204) — label / value pairs in two columns.
 */
export interface KvRow {
  label: ReactNode;
  value: ReactNode;
  key?: string;
}

export interface KvProps {
  rows: KvRow[];
  className?: string;
}

export function Kv({ rows, className }: KvProps) {
  return (
    <dl className={["kv", className ?? ""].filter(Boolean).join(" ")}>
      {rows.map((r, i) => {
        const k = r.key ?? String(i);
        return [<dt key={`${k}-t`}>{r.label}</dt>, <dd key={`${k}-d`}>{r.value}</dd>];
      })}
    </dl>
  );
}
