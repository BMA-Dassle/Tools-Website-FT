/**
 * `~/features/crm/leads` — capture, mint, assign, queue and My Day. Other
 * subs import THIS, never a data file (brief §3.2). Client components import
 * `./contracts` and `./queries` by path.
 */
export {
  ensureAccountsSchema,
  upsertAccountByName,
  accountNameKey,
  getAccount,
} from "./data/accounts-db";
export {
  ensureContactsSchema,
  upsertContact,
  patchContact,
  getContact,
  emailKeyOf,
  type ContactUpsert,
  type ContactPatch,
} from "./data/contacts-db";
export {
  ensureLeadsSchema,
  getLead,
  insertLead,
  listLeads,
  updateLeadFields,
  listUnassignedLeads,
  listDueLeads,
  listAssignedAwaitingTouch,
  countUnassignedLeads,
  countLeadsInStatus,
  volumeByRepMonth,
  findRecentDuplicateLead,
  leadNumericId,
  encodeCursor,
  decodeCursor,
  mapLeadRow,
  LEAD_LIST_MAX,
  type LeadListFilter,
  type LeadListPage,
  type LeadPatch,
  type LeadRowRaw,
  type NewLeadRow,
  type VolumeRow,
} from "./data/leads-db";
export {
  ensureAssignmentsSchema,
  insertAssignment,
  listAssignments,
  latestAssignment,
  markAssignmentResponsibleSynced,
  type NewAssignmentRow,
} from "./data/assignments-db";
export * from "./contracts";
export * from "./schemas";
export { leadsKeys, QUEUE_POLL_MS, MY_DAY_POLL_MS, BADGES_POLL_MS, type LeadsKey } from "./queries";
export {
  createLead,
  captureLine,
  defaultCreateLeadDeps,
  PROSPECT_SOURCES,
  type CreateLeadDeps,
  type CreateLeadInput,
  type CreateLeadOptions,
  type CreateLeadResult,
} from "./service/create-lead";
export {
  assignLead,
  syncResponsible,
  normalizeReason,
  nextActionForAssignment,
  defaultAssignDeps,
  FIRST_TOUCH_LABEL,
  LeadNotFoundError,
  RepNotAssignableError,
  type AssignDeps,
  type AssignLeadInput,
  type AssignResult,
} from "./service/assign";
export {
  mintProject,
  mintLead,
  mintBlocker,
  buildMintInput,
  pandoraEventTypeFor,
  mintOutcomeView,
  defaultMintDeps,
  defaultMintLeadDeps,
  EVENT_TYPE_TO_PANDORA,
  FIRST_AVAILABLE,
  NEEDS_EMAIL_OR_TIME,
  MINT_TIMEOUT_MS,
  MINT_JOB_KIND,
  type MintDeps,
  type MintExtras,
  type MintLeadDeps,
  type MintLeadResult,
  type MintOutcome,
} from "./service/mint";
export {
  notifyNewLead,
  notifyAlreadySent,
  queueCardSkipReason,
  summarizeNotify,
  centerConfigFor,
  defaultNotifyDeps,
  salesCardKey,
  withoutCardActions,
  ALREADY_SENT,
  QUEUE_CHAT_ENV,
  CENTRE_TO_CENTER_KEY,
  type ChannelOutcome,
  type NotifyDeps,
  type NotifyInput,
  type NotifyOutcome,
} from "./service/notify";
export {
  suggestFor,
  NO_SUGGESTION,
  type LeadSuggestion,
  type SuggestContext,
  type SuggestResult,
} from "./service/suggest";
export {
  recordFirstTouch,
  noteOutboundTouch,
  responseBadge,
  firstTouchMinutes,
  isOutboundTouch,
  TOUCH_KINDS,
  RESPONSE_WARN_MINUTES,
  RESPONSE_CRIT_MINUTES,
  type RecordFirstTouchInput,
  type RecordFirstTouchResult,
  type ResponseBadge,
} from "./service/response-time";
export {
  loadQueue,
  buildQueueLeads,
  buildRepColumns,
  queueMonths,
  autoAssignInMinutes,
  ageMinutes,
  defaultQueueDeps,
  type QueueBody,
  type QueueDeps,
} from "./service/queue";
export {
  loadMyDay,
  loadBadges,
  buildRepMyDay,
  buildLanes,
  bucketDue,
  greetingFor,
  dateLabelFor,
  endOfEasternDay,
  defaultMyDayDeps,
  type DueBuckets,
  type MyDayDeps,
} from "./service/my-day";
export {
  centreForCenterKey,
  webEventType,
  webBodyToCreateInput,
  buildPandoraNotes,
  friendlyEventLabel,
  legacyWebResponse,
  missingFieldsMessage,
  classifyWebSubmitIssues,
  isBlankWebValue,
  webSubmitErrorMessage,
  FORM_EVENT_TO_CRM,
  FORM_EVENT_FRIENDLY,
  WEB_DEFAULT_EVENT_TIME,
  WEB_REQUIRED_ORDER,
  type LegacyWebResponse,
  type WebSubmitRejection,
} from "./service/web-submit";
export { runLeadBmiJob, defaultLeadBmiJobDeps, type LeadBmiJobDeps } from "./service/jobs";
