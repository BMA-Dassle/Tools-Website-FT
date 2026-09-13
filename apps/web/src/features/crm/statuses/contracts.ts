/**
 * The statuses sub's WIRE SHAPES — the pipeline board and a status change.
 *
 * The board lives with the statuses because the COLUMNS ARE THE STATUSES: a
 * director who renames "Quote sent" or drops it off the board changes the
 * pipeline by editing `crm_statuses`, and nothing else. Keeping the two in one
 * sub is what makes that true rather than a coincidence.
 *
 * CLIENT-SAFE: type-only imports, no Node, no Neon. Ids are strings. The two
 * modules it re-exports types from (`service/bmi-state`, `service/board`) are
 * themselves pure, so a screen may import either by path — but never this
 * sub's `index.ts`, which pulls the Office transport in behind it (§5.7b).
 */

import type { ApiOk, PublicRep } from "../core/contracts";
import type { CrmStatus } from "../core/types";
import type { LeadView } from "../leads/contracts";
import type { BmiStateSyncOutcome } from "./service/bmi-state";
import type { BoardColumnView } from "./service/board";

export type { BmiStateBranch, BmiStateSyncOutcome, BmiSyncChip } from "./service/bmi-state";
export type { BoardColumnSpec, BoardColumnView, BoardLane, BoardView } from "./service/board";

/** GET /pipeline?by=rep&centre=&q= */
export type PipelineResponse = ApiOk<{
  columns: BoardColumnView[];
  leads: LeadView[];
  statuses: CrmStatus[];
  reps: PublicRep[];
  openCount: number;
  openValueCents: number;
  byRep: boolean;
  /** True when more leads exist than one board read loads — the board says so. */
  truncated: boolean;
}>;

/** POST /leads/[id]/status */
export type LeadStatusResponse = ApiOk<{
  lead: LeadView;
  status: CrmStatus;
  from: string;
  bmi: BmiStateSyncOutcome;
}>;

export const PIPELINE_TEST_IDS = {
  board: "crm-pipeline",
  column: (id: string) => "crm-pipeline-col-" + id,
  lane: (columnId: string, slug: string) => `crm-pipeline-lane-${columnId}-${slug}`,
  card: (publicId: string) => "crm-pipeline-card-" + publicId,
  dragGhost: "crm-pipeline-drag-ghost",
  statusSheet: "crm-status-sheet",
  byRepToggle: "crm-pipeline-by-rep",
} as const;

/** The board's one-line explanation of the drag (direction-b.html:73, verbatim). */
export const BOARD_DRAG_HINT = "Drag a card to change status → writes the mapped BMI state";

/** How many leads one board read loads (R10 caps a page at 200). */
export const PIPELINE_LEAD_LIMIT = 200;
