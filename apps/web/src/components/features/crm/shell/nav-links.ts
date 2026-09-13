import { CRM_BASE } from "~/features/crm/core/contracts";
import { MORE_ITEMS, NAV_GROUPS, PHONE_TABS } from "~/features/crm/core/nav";
import type { ScreenId } from "~/features/crm/core/types";

/**
 * Pure helpers shared by the sidebar, the bottom tabs and the topbar.
 * Same-origin RELATIVE paths only (brief §1.3: the session cookie is host-only,
 * so never `adminToolUrl()` absolutes).
 */

/** `/admin/crm` for My Day, `/admin/crm/<id>` otherwise. */
export function hrefFor(id: ScreenId): string {
  return id === "today" ? CRM_BASE : `${CRM_BASE}/${id}`;
}

/** Has any PR flipped this screen's `ready` line yet? */
export function isScreenReady(id: ScreenId): boolean {
  for (const g of NAV_GROUPS) for (const i of g.items) if (i.id === id) return i.ready;
  for (const t of PHONE_TABS) if (t.id === id) return t.ready;
  for (const m of MORE_ITEMS) if (m.id === id) return m.ready;
  return false;
}

/** Badge counts by provider key — PR1 ships no providers, so this is empty. */
export type BadgeCounts = Partial<
  Record<"overdue" | "unassigned" | "pendingApproval" | "unread", { n: number; soft?: boolean }>
>;
