/**
 * `~/features/crm/bmi` — the Office mirror (B1) AND the quote builder (C5).
 *
 * B1: backfill + delta jobs, the History & Accounts reads, the precision-safe
 * read transport (`transport.ts`).
 *
 * C5: the write transport (`office-write.ts`, over `putProjectFields` from
 * `lib/bmi-office-actions.ts` for project fields), the rail that drives it
 * (`service/builder.ts`), the catalogue (`service/catalog.ts`) and quote
 * templates (`service/templates.ts`).
 *
 * CLIENT MODULES DO NOT IMPORT THIS FILE. It pulls in `@ft/db`, `ioredis`,
 * `node:https` and the Office transports — none of which may reach a browser
 * bundle. A `"use client"` component imports the pure modules BY PATH:
 * `~/features/crm/bmi/contracts` and `~/features/crm/bmi/queries` (§5.7b).
 */
export { ensureBmiProjectsSchema } from "./data/projects-mirror-db";
export {
  claimProjectProductId,
  ensureQuoteLinesSchema,
  getQuoteLine,
  insertQuoteLine,
  listQuoteLines,
  listUnwrittenLines,
  mapQuoteLine,
  patchQuoteLine,
  type QuoteLineInput,
  type QuoteLinePatch,
  type QuoteLineRowRaw,
} from "./data/quote-lines-db";
export {
  archiveQuoteTemplate,
  bumpTemplateUse,
  ensureQuoteTemplatesSchema,
  getQuoteTemplate,
  insertQuoteTemplate,
  listQuoteTemplates,
  mapQuoteTemplate,
  templateLinesOf,
  type QuoteTemplateInput,
  type QuoteTemplateRowRaw,
} from "./data/quote-templates-db";
export {
  claimLeadProject,
  findLeadForBuilder,
  recordMintFailure,
  updateLeadEventDate,
  type BuilderLeadRow,
} from "./data/builder-lead-db";
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
  collectUserNames,
  mapWithConcurrency,
  officeDayPlanner,
  officeLiveReservations,
  officePerson,
  officeProject,
  tenantFacts,
  tenantResourceIds,
  type TenantFacts,
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
  BuilderCatalogQuerySchema,
  BuilderPostSchema,
  BuilderStateQuerySchema,
  BuilderTemplatesPostSchema,
  BuilderTemplatesQuerySchema,
  HistoryQuerySchema,
  LastYearQuerySchema,
  ScheduleBlockSchema,
  TemplateLineSchema,
  type BackfillPayloadInput,
  type BuilderCatalogQuery,
  type BuilderPostInput,
  type BuilderStateQuery,
  type BuilderTemplatesPostInput,
  type HistoryQueryInput,
} from "./schemas";
export { builderKeys, historyKeys, type BuilderKey, type HistoryKey } from "./queries";

// ── C5: the builder ────────────────────────────────────────────────────────
export {
  autocreateBody,
  autocreateProject,
  autosaveBody,
  autosaveProject,
  centsToDollars,
  createProjectProduct,
  deleteProjectProduct,
  dollarsToCents,
  downloadPerson,
  linkSchedule,
  linkScheduleBody,
  newWriteSession,
  officeStamp,
  officeWrite,
  productPrice,
  projectBalance,
  projectProductBody,
  putPerson,
  putScheduleBatch,
  refusalLine,
  scheduleBatchBody,
  searchPerson,
  toWirePrompt,
  type AutocreateInput,
  type AutosaveInput,
  type LinkScheduleInput,
  type OfficePersonHit,
  type OfficeWriteResult,
  type ProjectProductInput,
  type ScheduleBatchInput,
} from "./office-write";
export {
  CRM_BUILDER_SESSION_TAG,
  SYNC_PATIENCE_MS,
  addQuoteLine,
  applyTemplate,
  balanceFromProject,
  ensureOfficeProject,
  lastWriteInstant,
  linkLineSchedule,
  loadBuilderState,
  missingFromOffice,
  moveProjectDate,
  neonBuilderStore,
  officeOnlyLines,
  priceForDate,
  refreshHostPerson,
  removeQuoteLine,
  retryQuoteLine,
  splitOfficeStamp,
  syncStateFor,
  toBuilderProject,
  withProjectLock,
  writesStateFor,
  type AddLineInput,
  type BuilderContext,
  type BuilderStore,
  type LinkScheduleArgs,
} from "./service/builder";
export {
  CATALOG_LIMIT,
  CATALOG_UNAVAILABLE,
  rankCatalog,
  readCatalog,
  scoreProductName,
  type CatalogRead,
} from "./service/catalog";
export {
  scaleQuantity,
  scaleTemplate,
  templateLinesFromQuote,
  templateSummary,
  usageLabel,
} from "./service/templates";
export * from "./contracts";
