import type { ReactNode } from "react";

/**
 * The prototype's grey icon avatar beside a list row
 * (`<span class="avatar" style="background:var(--card2);color:var(--muted)">`,
 * crm-shared.js:431-432) — the same inline tokens, so no new CSS rule.
 */
export function IconAvatar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span
      className="avatar"
      title={label}
      style={{ background: "var(--card2)", color: "var(--muted)" }}
    >
      {children}
    </span>
  );
}
