/**
 * `~/features/crm/bmi` — the Office mirror (B1): backfill + delta jobs, the
 * History & Accounts reads, the precision-safe transport. C5 adds
 * `office-write.ts` (over `putProjectFields` from `lib/bmi-office-actions.ts`),
 * `builder.ts`, `availability-heats.ts` behind this same door.
 */
export { ensureBmiProjectsSchema } from "./data/projects-mirror-db";
export { ensureQuoteLinesSchema } from "./data/quote-lines-db";
export { ensureQuoteTemplatesSchema } from "./data/quote-templates-db";
export {
  BULK_CHUNK,
  countMirrorProjects,
  decodeCursor,
  encodeCursor,
  finishSyncRun,
  getMirrorKinds,
  getMirrorProject,
  lastOkSyncRun,
  listLastYearHosts,
  listMirrorProjectsForAccount,
  listSyncRuns,
  mapMirrorRow,
  mapSyncRun,
  phoneDigitsOf,
  searchMirrorProjects,
  startSyncRun,
  upsertMirrorRow,
  upsertMirrorRowsBulk,
  type MirrorCount,
  type MirrorLink,
  type MirrorProject,
  type MirrorRowRaw,
  type Page,
  type PageOpts,
  type SyncKind,
  type SyncRun,
  type SyncRunRaw,
} from "./data/projects-mirror-db";
export {
  CRM_BACKFILL_SESSION_TAG,
  CRM_DELTA_SESSION_TAG,
  DAYPLANNER_CONCURRENCY,
  DAYPLANNER_RESOURCE_BATCH,
  DETAIL_CONCURRENCY,
  chunk,
  collectResourceIds,
  mapWithConcurrency,
  officeDayPlanner,
  officeLiveReservations,
  officePerson,
  officeProject,
  tenantResourceIds,
} from "./transport";
export * from "./service/projection";
export * from "./service/windows";
export {
  defaultMirrorDeps,
  leadsLinker,
  neonMirrorStore,
  officeReader,
  type HostLinker,
  type MirrorDeps,
  type MirrorStore,
  type OfficeMetadata,
  type OfficeReader,
} from "./service/deps";
export {
  bmiMirrorBackfillHandler,
  cursorToPayload,
  makeBackfillHandler,
  mergeDayPlannerRefs,
  mirrorOneProject,
  runBackfillStep,
  summarizeFailures,
  type BackfillRunOptions,
  type BackfillRunResult,
  type DetailFailure,
  type MirroredProject,
} from "./service/mirror";
export {
  bmiMirrorDeltaHandler,
  enqueueDeltaTick,
  enqueueDeltaTicks,
  makeDeltaHandler,
  parseDeltaPayload,
  runDelta,
  type DeltaCursor,
  type DeltaRunOptions,
  type DeltaRunResult,
} from "./service/delta";
export {
  accountDetail,
  historySearch,
  lastYearHosts,
  mirrorStatus,
  repIndex,
  toMirrorEvent,
  type HistoryQuery,
  type RepIndex,
} from "./service/history";
export {
  AccountQuerySchema,
  BackfillPayloadSchema,
  HistoryQuerySchema,
  LastYearQuerySchema,
  type BackfillPayloadInput,
  type HistoryQueryInput,
} from "./schemas";
export { historyKeys, type HistoryKey } from "./queries";
