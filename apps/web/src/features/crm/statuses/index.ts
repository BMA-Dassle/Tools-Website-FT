/**
 * `~/features/crm/statuses` — our pipeline statuses, their BMI state map and
 * the pure projections built on them (the board, the branch table).
 *
 * TWO MODULES ARE DELIBERATELY NOT HERE, and both are imported by their own
 * path instead — `service/transition.ts` and `service/pipeline.ts`:
 *
 *   `leads/data/leads-db.ts` imports THIS barrel for `ensureStatusesSchema`
 *   (the `crm_leads.status_id` foreign key). Both of those modules import
 *   `~/features/crm/leads` back, so exporting them here closes a cycle
 *   statuses → leads → statuses. Under Vite's module runner that cycle
 *   deadlocked `ensureCrmSchema()` outright (schema.test.ts timed out), and
 *   even resolved it would drag `lib/bmi-office-actions` and ioredis into the
 *   import graph of every module that reads a lead — the §5.7b hazard, one
 *   step further upstream.
 *
 *   So: route handlers and `activities/service/actions.ts` import
 *   `~/features/crm/statuses/service/transition` and
 *   `~/features/crm/statuses/service/pipeline` directly. That keeps §3.2's
 *   intent — one door per sub for the things other subs reuse — while leaving
 *   the two leads-dependent services outside the cycle.
 *
 * Client components import `./contracts`, `./queries`, `./service/board` and
 * `./service/bmi-state` by PATH — all four are pure — and never this barrel.
 */
export {
  STATUS_ID_RE,
  archiveStatus,
  ensureStatusesSchema,
  getStatus,
  listStatuses,
  mapStatusRow,
  reorderStatuses,
  seedStatuses,
  upsertStatus,
  type StatusRowRaw,
} from "./data/statuses-db";
export {
  deleteStatusMap,
  ensureStatusMapSchema,
  getStatusMapping,
  listStatusMap,
  upsertStatusMap,
} from "./data/status-map-db";
export {
  STATUS_BMI_STATE_NAMES,
  UNPROPOSED_OFFICE_STATES,
  listOfficeStateNames,
  normalizeStateName,
  proposeStatusMap,
  stateNamesToList,
  type MetadataReader,
  type OfficeStatesResult,
} from "./service/bmi-states";
export {
  bmiStateBranch,
  bmiSyncChipFor,
  isRailedStateId,
  transitionToastFor,
  type BmiStateBranch,
  type BmiStateBranchInput,
  type BmiStateSyncOutcome,
  type BmiStateSyncStatus,
  type BmiSyncChip,
} from "./service/bmi-state";
export {
  BOOKED_COLUMN_ID,
  CLOSED_COLUMN_ID,
  REP_ORDER,
  SYNTHETIC_COLUMN_IDS,
  boardColumns,
  buildBoard,
  columnDropTarget,
  leadInColumn,
  syntheticColumns,
  type BoardColumnSpec,
  type BoardColumnView,
  type BoardLane,
  type BoardView,
  type BuildBoardInput,
} from "./service/board";
export * from "./contracts";
export * from "./schemas";
export { PIPELINE_POLL_MS, pipelineKeys, type PipelineKey } from "./queries";
