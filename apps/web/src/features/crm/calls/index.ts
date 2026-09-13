/**
 * `~/features/crm/calls` — 3CX click-to-call, journalling, reconcile and
 * dispositions. Other subs import THIS, never a data or service file
 * (brief §3.2). Client components import `./contracts`, `./schemas` and
 * `./queries` by path.
 */

export {
  CALL_LIST_DEFAULT,
  CALL_LIST_MAX,
  EMPTY_CALL_STATS,
  callStats,
  decodeCallCursor,
  encodeCallCursor,
  ensureCallsSchema,
  getCall,
  latestCallStartedAt,
  linkCall,
  listCalls,
  mapCallRow,
  setCallDisposition,
  upsertCall,
  type CallDispositionPatch,
  type CallListFilter,
  type CallListPage,
  type CallRowRaw,
  type CallStats,
  type CallUpsert,
} from "./data/calls-db";

export * from "./contracts";
export * from "./schemas";
export { callsKeys, CALLS_POLL_MS, CALL_BADGES_POLL_MS, type CallsKey } from "./queries";

export {
  CALL_LOG_MAX,
  THREECX_DEFAULT_BASE,
  THREECX_TIMEOUT_MS,
  ThreecxError,
  callLogPath,
  fetchCallLog,
  getCallControlDn,
  getThreecxToken,
  listCallControl,
  listUsers,
  makeCall,
  odataInstant,
  probe,
  redactNumbers,
  resetThreecxTokenCache,
  threecxBase,
  threecxConfigured,
  threecxFetch,
  type CallControlDn,
  type CallControlParticipant,
  type CallLogRow,
  type MakeCallResult,
  type ProbeReport,
  type ProbeStep,
  type ThreecxUser,
} from "./service/threecx";

export {
  MIN_MATCHABLE_DIGITS,
  NO_MATCH,
  callerLabel,
  isExtensionDn,
  lastTen,
  matchNumber,
  repForExtension,
  sameNumber,
  toE164,
  type NumberMatch,
} from "./service/match";

export {
  RECONCILE_COLD_START_HOURS,
  RECONCILE_MAX_ROWS,
  RECONCILE_OVERLAP_MINUTES,
  defaultPersistDeps,
  defaultReconcileDeps,
  foldLegs,
  groupCallLog,
  legDirection,
  legParties,
  parseIsoDuration,
  persistCall,
  reconcileCalls,
  reconcileIdempotencyKey,
  recordJournalCall,
  type JournalPayload,
  type LegParties,
  type NormalizedCall,
  type PersistDeps,
  type ReconcileDeps,
  type ReconcileResult,
} from "./service/journal";

export {
  DIAL_RING_SECONDS,
  defaultDialDeps,
  dialBlockedReason,
  startCall,
  type DialDeps,
  type DialInput,
  type DialResult,
} from "./service/dial";

export {
  CallNotFoundError,
  REACHED,
  STATUS_AFTER_CONTACT,
  STATUS_BEFORE_CONTACT,
  applyDisposition,
  defaultDispositionDeps,
  leadPatchFor,
  type DispositionDeps,
  type DispositionInput,
  type DispositionResult,
} from "./service/dispositions";

export {
  TRAY_MAX,
  connectivityFor,
  defaultBoardDeps,
  loadCallsBoard,
  scopeRepId,
  type BoardDeps,
  type CallsBoardQuery,
} from "./service/board";

export { CRM_PUBLIC_ORIGIN, crmAbsoluteUrl, lookupByNumber } from "./service/lookup";

export {
  THREECX_SECRET_ENV,
  THREECX_SECRET_HEADER,
  THREECX_SECRET_QUERY,
  offeredSecret,
  threecxSecretConfigured,
  threecxSecretOk,
  threecxUnauthorized,
} from "./service/secret";

export { runThreecxReconcileJob, type ReconcileJobDeps } from "./service/jobs";
