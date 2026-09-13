/**
 * `~/features/crm/sms` — per-rep DIDs, two-way threads, the Conversations Text
 * tab. Other subs import THIS, never a data file (brief §3.2). Client
 * components import `./types`, `./keys` and `./queries` by path.
 */
export {
  ensureSmsThreadsSchema,
  getThread,
  linkThread,
  listThreads,
  markInbound,
  markOutbound,
  markThreadsRead,
  setThreadStopped,
  threadColumns,
  threadsForContact,
  threadsForGuest,
  unreadTotal,
  upsertThread,
  type ThreadListFilter,
  type ThreadUpsert,
} from "./data/threads-db";
export {
  ensureSmsMessagesSchema,
  getMessage,
  hasInboundFrom,
  insertMessage,
  lastMessagePerThread,
  listFailedOutbound,
  listMessagesForThreads,
  mapMessageRow,
  patchDeliveryStatus,
  patchSendOutcome,
  MESSAGE_PAGE_MAX,
  type NewMessage,
  type SendOutcomePatch,
} from "./data/messages-db";
export {
  contactById,
  contactByPhone,
  contactsByIds,
  contactsByPhones,
  leadById,
  leadForContact,
  leadsByContactIds,
  resolveGuestLink,
  type GuestLink,
} from "./data/links-db";
export * from "./types";
export * from "./keys";
export * from "./schemas";
export { smsKeys, CONVERSATIONS_POLL_MS, THREAD_POLL_MS, type SmsKey } from "./queries";
export {
  consentBasisOnly,
  consentFor,
  isEnquirySource,
  ENQUIRY_SOURCES,
  PROSPECTING_SOURCES,
  type ConsentFacts,
} from "./service/consent";
export { activeRepDids, repForDid, resetDidCache, unionDids } from "./service/dids";
export {
  mergeTemplate,
  mergeValues,
  normalizeForGsm7,
  renderTemplate,
  toGsm7,
  type Gsm7Result,
  type MergeContext,
  type MergeResult,
} from "./service/templates-merge";
export { loadRenderedTemplates, type LoadTemplatesInput } from "./service/templates";
export {
  defaultSendDeps,
  destinationFor,
  retryCrmSms,
  sendCrmSms,
  smsRetryIdempotencyKey,
  SMS_RETRY_JOB_KIND,
  type SendDeps,
  type SendSmsInput,
} from "./service/send";
export {
  defaultInboundDeps,
  inboundReplyEffect,
  noteConsentOnRepDid,
  routeInbound,
  START_SYSTEM_LINE,
  STOP_SYSTEM_LINE,
  type InboundDeps,
  type InboundRouteResult,
  type ReplySender,
} from "./service/inbound";
export {
  foldConversations,
  loadConversation,
  loadConversations,
  markConversationRead,
  UnknownConversationError,
  type ConversationsPage,
  type FoldInput,
  type LoadConversationInput,
  type LoadConversationsInput,
} from "./service/threads";
export { defaultSmsRetryJobDeps, runSmsSendRetryJob, type SmsRetryJobDeps } from "./service/jobs";
