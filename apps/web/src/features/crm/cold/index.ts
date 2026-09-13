/**
 * `~/features/crm/cold` — cold-list import, de-duplication, the dialling list
 * and conversion. Other SERVER code imports THIS, never a data or service file
 * (brief §3.2).
 *
 * A `"use client"` component must NOT import this barrel (§5.7b): it re-exports
 * the services, whose module graph reaches `@ft/db` and `ioredis`, and one such
 * import drags Node built-ins into the browser bundle and kills the Vercel
 * build. Client components import `./contracts`, `./csv`, `./mapping`,
 * `./dedupe`, `./schemas` and `./queries` BY PATH — all five are pure.
 */

export * from "./contracts";
export * from "./csv";
export * from "./mapping";
export * from "./dedupe";
export * from "./schemas";
export { coldKeys, COLD_POLL_MS, type ColdKey } from "./queries";

export {
  coldListStats,
  ensureColdListsSchema,
  getColdList,
  insertColdList,
  listColdLists,
  mapColdListRow,
  refreshColdRowCount,
  updateColdList,
  type ColdListFilter,
  type ColdListPatch,
  type ColdListRowRaw,
  type NewColdList,
} from "./data/lists-db";

export {
  applyColdProjections,
  coldRowTotals,
  commitColdRows,
  decodeColdCursor,
  encodeColdCursor,
  ensureColdRowsSchema,
  findColdCandidates,
  getColdRow,
  insertColdRows,
  linkColdRowLead,
  listColdMatches,
  listColdRawRecords,
  listColdRows,
  mapColdRow,
  nextColdRow,
  setColdRowDecision,
  setColdRowDisposition,
  type ColdCommitCounts,
  type ColdDispositionPatch,
  type ColdRawRecord,
  type ColdRowProjectionPatch,
  type ColdRowRaw,
  type ColdRowsPage,
  type ColdRowTotals,
} from "./data/rows-db";

export {
  ColdListFullError,
  ColdListNotFoundError,
  appendColdRows,
  buildReport,
  commitColdList,
  createColdList,
  mapColdList,
  unique,
  type CreateColdListInput,
} from "./service/import";

export {
  ColdRowNotFoundError,
  applyColdDisposition,
  callbackFor,
  coldActivityRef,
  convertColdRow,
  defaultColdDispositionDeps,
  type ColdConvertInput,
  type ColdConvertResult,
  type ColdDispositionDeps,
  type ColdDispositionInput,
  type ColdDispositionResult,
} from "./service/dispositions";

export {
  loadColdListBoard,
  loadColdListsBoard,
  type ColdListBoard,
  type ColdListQuery,
  type ColdListsBoard,
  type ColdListsQuery as ColdListsBoardQuery,
} from "./service/board";
