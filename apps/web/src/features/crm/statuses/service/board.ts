/**
 * THE PIPELINE BOARD, as a pure projection (direction-b.html:67-68).
 *
 * The columns are OUR statuses — the on-board ones, in `position` order —
 * plus the two SYNTHETIC columns the prototype appends:
 *
 *   cols = D.statuses.filter(s => !["new","deposit","confirmed","lost","noresp"].includes(s.id))
 *          .concat([{id:"won", label:"Booked", kind:"won"},
 *                   {id:"closed", label:"Closed", kind:"lost"}])
 *
 * "Booked" and "Closed" are NOT rows in `crm_statuses`; they are buckets for
 * every status of that KIND, which is why a lead that is `deposit`,
 * `confirmed` or a future won status all land in Booked without anybody
 * maintaining a list. The seed marks exactly those five ids `on_board = false`
 * (`core/seed.ts` OFF_BOARD_STATUS_IDS), so the filter is a column read, not a
 * hard-coded list repeated here.
 *
 * Dropping a card on a synthetic column is refused, and the UI does not offer
 * it: "Booked" is what a paid deposit MEANS, not something a rep declares.
 * `columnDropTarget` is the one function that says so, and the board and the
 * status sheet both ask it.
 *
 * `?by=rep` groups each column's cards by rep in `REP_ORDER`
 * (direction-b.html:69), with the prototype's late dot on any rep whose cards
 * include an overdue open lead.
 */

import type { PublicRep } from "../../core/contracts";
import type { CrmStatus, StatusKind } from "../../core/types";
import type { LeadView } from "../../leads/contracts";

/** The synthetic column ids — never `crm_statuses` rows. */
export const BOOKED_COLUMN_ID = "won";
export const CLOSED_COLUMN_ID = "closed";

export const SYNTHETIC_COLUMN_IDS: readonly string[] = [BOOKED_COLUMN_ID, CLOSED_COLUMN_ID];

/** Rep order on the swimlane view (direction-b.html:69), by slug. */
export const REP_ORDER: readonly string[] = ["kelsea", "lori", "stephanie", "gs", "mkt"];

export interface BoardColumnSpec {
  id: string;
  label: string;
  kind: StatusKind;
  /** False for Booked / Closed — they are kinds, not statuses. */
  droppable: boolean;
  /** The `crm_statuses` row behind a real column; null for the synthetic two. */
  status: CrmStatus | null;
}

export interface BoardLane {
  repId: string | null;
  repSlug: string | null;
  repName: string | null;
  initials: string | null;
  leadIds: string[];
  /** Any open lead in this lane whose next action is past due. */
  hasOverdue: boolean;
}

export interface BoardColumnView extends BoardColumnSpec {
  leadIds: string[];
  count: number;
  /** Σ `value_cents` of the column's leads — the `.sum` in the header. */
  sumCents: number;
  /** Only present on `?by=rep`. */
  lanes: BoardLane[] | null;
}

/** The two synthetic columns, in the prototype's order and with its labels. */
export function syntheticColumns(): BoardColumnSpec[] {
  return [
    {
      id: BOOKED_COLUMN_ID,
      label: "Booked",
      kind: "won",
      droppable: false,
      status: null,
    },
    {
      id: CLOSED_COLUMN_ID,
      label: "Closed",
      kind: "lost",
      droppable: false,
      status: null,
    },
  ];
}

/** On-board statuses in position order, then Booked and Closed. */
export function boardColumns(statuses: readonly CrmStatus[]): BoardColumnSpec[] {
  const real = statuses
    .filter((s) => s.onBoard && !s.archivedAt)
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map<BoardColumnSpec>((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      droppable: true,
      status: s,
    }));
  return [...real, ...syntheticColumns()];
}

/**
 * `inCol(l, c)` (direction-b.html:68): the synthetic columns match by the
 * KIND of the lead's status; a real column matches the status id exactly.
 */
export function leadInColumn(
  lead: Pick<LeadView, "status">,
  column: Pick<BoardColumnSpec, "id">,
  statusKind: (statusId: string) => StatusKind | undefined,
): boolean {
  if (column.id === BOOKED_COLUMN_ID) return statusKind(lead.status) === "won";
  if (column.id === CLOSED_COLUMN_ID) return statusKind(lead.status) === "lost";
  return lead.status === column.id;
}

/**
 * Where a card may be dropped: a real column, and only a real column.
 * Returns the status id to transition to, or null when the drop is refused.
 */
export function columnDropTarget(
  columns: readonly BoardColumnSpec[],
  columnId: string,
): string | null {
  const col = columns.find((c) => c.id === columnId);
  return col && col.droppable ? col.id : null;
}

function isOverdue(lead: LeadView, kind: StatusKind | undefined, now: Date): boolean {
  if (kind !== "open" || !lead.nextAction) return false;
  const due = Date.parse(lead.nextAction.due);
  return Number.isFinite(due) && due < now.getTime();
}

function laneOrder(slug: string | null): number {
  const ix = slug ? REP_ORDER.indexOf(slug) : -1;
  return ix < 0 ? REP_ORDER.length : ix;
}

export interface BuildBoardInput {
  leads: readonly LeadView[];
  statuses: readonly CrmStatus[];
  reps: readonly PublicRep[];
  byRep: boolean;
  now: Date;
}

export interface BoardView {
  columns: BoardColumnView[];
  /** Every lead the columns reference, in one list the client indexes by id. */
  leads: LeadView[];
  openCount: number;
  openValueCents: number;
}

/**
 * The board in one pass. Leads that fall in NO column (a `new` lead waiting in
 * the queue, an archived one) are simply absent — the board shows work in
 * flight, and the queue shows what has not started.
 */
export function buildBoard(input: BuildBoardInput): BoardView {
  const { leads, statuses, reps, byRep, now } = input;
  const kindById = new Map(statuses.map((s) => [s.id, s.kind]));
  const kindOf = (id: string) => kindById.get(id);
  const repById = new Map(reps.map((r) => [r.id, r]));
  const columns = boardColumns(statuses);

  const used = new Set<string>();
  const views = columns.map<BoardColumnView>((c) => {
    const mine = leads.filter((l) => leadInColumn(l, c, kindOf));
    for (const l of mine) used.add(l.id);
    const sumCents = mine.reduce((a, l) => a + (l.valueCents || 0), 0);
    let lanes: BoardLane[] | null = null;
    if (byRep) {
      const groups = new Map<string, LeadView[]>();
      for (const l of mine) {
        const key = l.rep ?? "";
        const list = groups.get(key);
        if (list) list.push(l);
        else groups.set(key, [l]);
      }
      lanes = [...groups.entries()]
        .map<BoardLane>(([repId, list]) => {
          const rep = repId ? repById.get(repId) : undefined;
          const slug = rep?.slug ?? list[0]?.repSlug ?? null;
          return {
            repId: repId || null,
            repSlug: slug,
            repName: rep?.displayName ?? list[0]?.repName ?? null,
            initials: rep?.initials ?? null,
            leadIds: list.map((l) => l.id),
            hasOverdue: list.some((l) => isOverdue(l, kindOf(l.status), now)),
          };
        })
        .sort(
          (a, b) =>
            laneOrder(a.repSlug) - laneOrder(b.repSlug) ||
            (a.repName ?? "").localeCompare(b.repName ?? ""),
        );
      // A rep with no cards in this column has no lane — the prototype filters
      // REP_ORDER by `ls.some(l => l.rep === id)` for exactly that reason.
    }
    return {
      ...c,
      leadIds: mine.map((l) => l.id),
      count: mine.length,
      sumCents,
      lanes,
    };
  });

  const onBoard = leads.filter((l) => used.has(l.id));
  const open = onBoard.filter((l) => kindOf(l.status) === "open");
  return {
    columns: views,
    leads: onBoard,
    openCount: open.length,
    openValueCents: open.reduce((a, l) => a + (l.valueCents || 0), 0),
  };
}
