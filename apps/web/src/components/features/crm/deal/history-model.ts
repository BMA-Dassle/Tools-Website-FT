import type { CrmActivity } from "~/features/crm/core/types";
import type { ContractHistoryEntry } from "~/features/daily-events/types";

/**
 * The History tab's merge (crm-events.js:172) — "contract audit log · versions
 * · status changes · BMI syncs", newest first.
 *
 * PURE, and in its own file rather than inside `HistoryTab.tsx`, because this
 * is the decision the tab makes and R12 wants the decision testable without
 * rendering React.
 *
 * Two sources: the CONTRACT's own history, which
 * `daily-events/service.ts getContractHistory` already assembles for the
 * reservations-admin board (audit ledger + versions + milestones, consecutive
 * guest views collapsed), and the CRM's own `crm_activities` for this lead.
 * Reusing the first rather than rebuilding it is why the two boards cannot
 * drift apart.
 */

export type HistoryKind = "contract" | "version" | "status" | "bmi" | "system";

export interface MergedHistoryRow {
  key: string;
  at: string;
  kind: HistoryKind;
  text: string;
  detail: string | null;
  who: string | null;
  count?: number;
  pdfUrl?: string | null;
}

/**
 * The CRM activity kinds this tab shows. `call`, `sms`, `email`, `note` and
 * `reachout` are conversation, not history — they live on the Overview
 * timeline, and repeating them here would bury the money and state events
 * this tab exists to show.
 */
export const HISTORY_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "status",
  "bmi",
  "system",
  "payment",
  "assign",
]);

export function mergeHistory(
  entries: readonly ContractHistoryEntry[],
  activities: readonly CrmActivity[],
): MergedHistoryRow[] {
  const rows: MergedHistoryRow[] = [];
  for (const e of entries) {
    rows.push({
      key: `c-${e.kind}-${e.at}-${e.label}`,
      at: e.at,
      kind: e.kind === "version" ? "version" : "contract",
      text: e.label,
      detail: e.detail ?? null,
      who: e.actor ?? null,
      count: e.count,
      pdfUrl: e.pdfUrl ?? null,
    });
  }
  for (const a of activities) {
    if (!HISTORY_ACTIVITY_KINDS.has(a.kind)) continue;
    rows.push({
      key: `a-${a.id}`,
      at: a.occurredAt,
      kind: a.kind === "bmi" ? "bmi" : a.kind === "status" ? "status" : "system",
      text: a.body ?? a.subject ?? a.kind,
      detail: null,
      who: a.actorEmail ?? null,
    });
  }
  // Newest first. `Date.parse` of an unparseable stamp is NaN, and NaN in a
  // comparator scrambles the whole list — so an undated row sorts last rather
  // than taking the rest of the timeline down with it.
  return rows.sort((x, y) => {
    const bx = Date.parse(x.at);
    const by = Date.parse(y.at);
    if (Number.isNaN(bx) && Number.isNaN(by)) return 0;
    if (Number.isNaN(bx)) return 1;
    if (Number.isNaN(by)) return -1;
    return by - bx;
  });
}
