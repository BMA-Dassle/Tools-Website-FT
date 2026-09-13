/**
 * `~/features/crm/email` — Graph send and read. Other subs import THIS, never
 * a data or service file (brief §3.2). Client components import
 * `./contracts` and `./queries` by path.
 */

export {
  ensureEmailSchema,
  findLinkByInternetMessageId,
  findSubscriptionById,
  getLink,
  insertGraphLinkOnce,
  insertOutboundLink,
  listEmailThreads,
  listLeadEmails,
  listSubscriptions,
  markLinkFailed,
  markLinkSent,
  mapEmailLinkRow,
  recordSubscription,
  recordSubscriptionError,
  setLinkGraphMessageId,
  upsertSubscriptionRow,
  GRAPH_FOLDERS,
  MAX_PAGE,
  type EmailLink,
  type EmailLinkRowRaw,
  type GraphFolder,
  type GraphSubscriptionRow,
  type GraphLinkInput,
  type OutboundLinkInput,
} from "./data/email-links-db";

export * from "./contracts";
export * from "./schemas";
export { emailKeys, EMAIL_POLL_MS, type EmailKey } from "./queries";

export {
  GRAPH_DRAFT_ROLE,
  GRAPH_NOT_CONFIGURED_REASON,
  GRAPH_READ_ROLE,
  GRAPH_SEND_ROLE,
  GraphError,
  IMMUTABLE_ID_PREFER,
  MESSAGE_SELECT,
  READINESS_TTL_MS,
  SUBSCRIPTION_MAX_MINUTES,
  X_HP_LEAD_HEADER,
  createDraft,
  createSubscription,
  draftBody,
  getGraphToken,
  getMessage,
  graphConfigured,
  graphFetch,
  graphSendReadiness,
  listInboxTop,
  readGraphEnv,
  readinessFromRoles,
  renewSubscription,
  resetGraphReadinessCache,
  resetGraphTokenCache,
  sendDraft,
  subscriptionExpiry,
  subscriptionResource,
  tokenRoles,
  type DraftInput,
  type GraphEnv,
  type GraphMessage,
  type GraphReadiness,
  type GraphRecipient,
  type GraphSubscription,
} from "./service/graph-client";

export {
  CRM_EMAIL_OFF_REASON,
  GUEST_SERVICES_SLUG,
  MERGE_TOKENS,
  MESSAGE_ID_DOMAIN,
  NoSenderMailboxError,
  applyReadiness,
  crmMessageId,
  emailTemplatesFor,
  mergeTemplate,
  mergeValues,
  resolveSender,
  unresolvedTokens,
  type MergeContext,
  type MergeToken,
} from "./service/compose";

export {
  EMAIL_ACTIVITY_EXTERNAL_KIND,
  NoRecipientError,
  STATUS_ON_FIRST_TOUCH,
  defaultSendDeps,
  sendCrmEmail,
  shouldFallBack,
  textToHtml,
  type SendCrmEmailInput,
  type SendCrmEmailResult,
  type SendDeps,
} from "./service/send";

export { matchedByOf, toMessageView } from "./service/view";

export {
  IN_REPLY_TO_HEADER,
  NO_MATCH,
  PREVIEW_MAX,
  addressOf,
  addressesOf,
  counterpartyOf,
  directionOf,
  emailKeyOf,
  firstMessageId,
  headerValue,
  matchMessage,
  occurredAtOf,
  preferredLead,
  previewOf,
  type MatchDeps,
  type MatchResult,
  type MatchedLead,
} from "./service/match";

export {
  GRAPH_WEBHOOK_PATH,
  RENEW_WITHIN_MS,
  clientStateMatches,
  defaultSubscriptionDeps,
  ensureSubscriptions,
  graphWebhookUrl,
  needsRenewal,
  newClientState,
  type EnsureSubscriptionsResult,
  type SubscriptionDeps,
  type SubscriptionOutcome,
} from "./service/subscriptions";

export {
  CLOSED_STATUS_IDS,
  defaultWebhookDeps,
  handleNotification,
  linkGraphMessage,
  neonMatchDeps,
  parseResource,
  toMatchedLead,
  type GraphNotification,
  type GraphNotificationBody,
  type NotificationOutcome,
  type WebhookDeps,
} from "./service/webhook";

export {
  decodeEmailCursor,
  emailThreads,
  encodeEmailCursor,
  leadEmails,
  type EmailThreadsResult,
  type LeadEmailsResult,
} from "./service/threads";

export {
  GRAPH_FETCH_MESSAGE_KIND,
  GRAPH_RENEW_KIND,
  graphFetchIdempotencyKey,
  graphRenewIdempotencyKey,
  runGraphFetchMessageJob,
  runGraphRenewJob,
  subscribedMailboxes,
} from "./service/jobs";
