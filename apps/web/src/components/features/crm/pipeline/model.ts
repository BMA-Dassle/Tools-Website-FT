import { moneyK, money } from "~/features/crm/core/format";
import type { CrmStatus, StatusBmiMapRow } from "~/features/crm/core/types";
import type { LeadView } from "~/features/crm/leads/contracts";
import type { BoardColumnView } from "~/features/crm/statuses/contracts";

/**
 * Pure helpers behind the pipeline board — no hooks, no fetch, no DOM. Tested.
 *
 * CLIENT-SAFE IMPORTS ONLY: `core/format`, `core/types`, and the two sub
 * `contracts.ts` files. Never a sub's `index.ts` — that barrel reaches the
 * Office transport and ioredis, and one such import fails the production build
 * (§5.7b, proven on feat/crm-availability).
 */

/** `12 open · $84,300 quoted` (direction-b.html:75, verbatim shape). */
export function boardSubtitle(openCount: number, openValueCents: number): string {
  return `${openCount} open · ${money(openValueCents)} quoted`;
}

/** The `.sum` in a column header — omitted when the column has no value. */
export function columnSum(column: Pick<BoardColumnView, "sumCents">): string | null {
  return column.sumCents ? moneyK(column.sumCents) : null;
}

export function leadIndex(leads: readonly LeadView[]): Map<string, LeadView> {
  return new Map(leads.map((l) => [l.id, l]));
}

/** `?cols=all` — the planner asked to see every column at full width. */
export const SHOW_ALL_COLUMNS = "all";

/**
 * Which columns shrink to a rail (owner, 2026-09-13: "should pipeline hide
 * unused columns by default?").
 *
 * The empty ones — EXCEPT when the planner has asked for all of them, and
 * except the one a card is being dragged over, which springs back to full width
 * so there is somewhere to aim. That last exception is what keeps "collapse"
 * from quietly becoming "hide": every stage stays reachable by drag.
 */
export function railColumnIds(
  columns: readonly Pick<BoardColumnView, "id" | "count">[],
  opts: { showAll: boolean; overColumnId: string | null },
): Set<string> {
  if (opts.showAll) return new Set();
  return new Set(
    columns.filter((c) => c.count === 0 && c.id !== opts.overColumnId).map((c) => c.id),
  );
}

/**
 * The board's `grid-template-columns`, one track per column in board order.
 *
 * Null when nothing is collapsed, and that null matters: without it the board
 * sets no template at all and `grid-auto-columns` keeps sizing the tracks
 * exactly as it always has — including the phone's `86%` swipe columns and the
 * queue's 300px. A template is only worth declaring when the widths differ.
 */
export function boardTracks(
  columns: readonly Pick<BoardColumnView, "id">[],
  rails: ReadonlySet<string>,
): string | null {
  if (rails.size === 0) return null;
  return columns.map((c) => (rails.has(c.id) ? "var(--col-rail-w)" : "var(--col-w)")).join(" ");
}

export interface StatusOption {
  status: CrmStatus;
  /** True for the lead's current status — the `.opt.pick` row. */
  current: boolean;
  /**
   * "Writes BMI state Send Contract · 48 h follow-up" — the prototype's `.why`
   * line, made TRUTHFUL: when the status has no map row for this tenant it
   * says so instead of naming a state that will never be written.
   */
  why: string;
  /** Null when the status is unmapped for this centre. */
  bmiStateName: string | null;
  /** True when the mapped state is a built-in (negative) id — the Contract tab's job. */
  builtIn: boolean;
}

/**
 * The rows of the "Change status" sheet (crm-shared.js:280), one per status,
 * each stating exactly what it will do in Office for THIS lead's centre.
 */
export function statusOptions(
  statuses: readonly CrmStatus[],
  lead: Pick<LeadView, "status">,
  map: readonly StatusBmiMapRow[],
  clientKey: string,
): StatusOption[] {
  const byStatus = new Map(
    map.filter((m) => m.clientKey === clientKey).map((m) => [m.statusId, m]),
  );
  return statuses
    .filter((s) => !s.archivedAt)
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((status) => {
      const mapping = byStatus.get(status.id) ?? null;
      const builtIn = !!mapping && mapping.bmiStateId.trim().startsWith("-");
      const sla = status.slaLabel ? ` · ${status.slaLabel}` : "";
      const why = !mapping
        ? `No BMI state mapped for this centre — the CRM moves, Office does not${sla}`
        : builtIn
          ? `Built-in Office state ${mapping.bmiStateId} — set from the Contract tab${sla}`
          : `Writes BMI state ${mapping.bmiStateName}${sla}`;
      return {
        status,
        current: status.id === lead.status,
        why,
        bmiStateName: mapping?.bmiStateName ?? null,
        builtIn,
      };
    });
}
