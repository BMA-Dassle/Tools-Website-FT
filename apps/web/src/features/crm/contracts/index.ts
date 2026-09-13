/**
 * `~/features/crm/contracts` — the group-event contract rail folded into the
 * CRM. Other subs and the route handlers import THIS; client components import
 * `./contracts` (wire types) and `./queries` (keys) BY PATH and never this
 * barrel, which pulls Neon, Square and the Office client into the bundle and
 * kills the build (§5.7b, feat/crm-availability @ fbfc8a7).
 */

export * from "./contracts";
export * from "./schemas";
export { contractsKeys, CONTRACT_BADGES_POLL_MS, type ContractsKey } from "./queries";

export {
  ATTENTION_SQL,
  CLOSED_FOR_ATTENTION,
  PAST_UNPAID_DAYOF_SQL,
  UNSIGNED_AGE_MINUTES,
  attentionReasons,
  attentionTone,
  pastUnpaidDayof,
  type AttentionInput,
} from "./service/attention";

export {
  centreForCenterCode,
  repIndexByEmail,
  repRef,
  toContractRow,
  type QuoteRowSource,
  type RowContext,
} from "./service/rows";

export {
  EMPTY_COUNTS,
  buildContractWhere,
  contractCounts,
  decodeContractCursor,
  encodeContractCursor,
  getContractRow,
  listContracts,
  rowContext,
  type ContractListFilter,
  type ContractListPage,
} from "./service/list";

export {
  AUDIT_LABEL,
  CONTRACTS_FOOTER,
  GUEST_MESSAGES_FOOTER,
  NOTIFICATION_RULE_LABEL,
  auditDetail,
  auditLabel,
  humaniseEvent,
  notificationRuleLabel,
} from "./service/labels";

export {
  CONTRACT_AUDIT_ENTITY,
  cancelVerifyJobKey,
  contractDetail,
  contractHistory,
  contractPayments,
  contractPublicNotes,
  guestUrlFor,
  isCancelPending,
  publicNotesFromProject,
  toLineItems,
  type PaymentsResult,
  type PublicNotesResult,
} from "./service/detail";

export {
  CANCELLED_STATE_ID,
  CANCEL_VERIFY_ATTEMPTS,
  CANCEL_VERIFY_GAP_MS,
  CANCEL_VERIFY_JOB_KIND,
  CONTRACT_ENTITY,
  ContractActionError,
  approveContract,
  backfillDayofOrder,
  cancelEvent,
  cancelPendingFor,
  centreCodeForQuote,
  chargeBalance,
  clientKeyForCenterCode,
  defaultActionDeps,
  denyContract,
  fireReminder,
  pollProjectState,
  resendContract,
  runCancelVerifyJob,
  type ActionDeps,
  type ActionInput,
  type ActionResult,
  type CancelResult,
} from "./service/actions";

export { shortIdFrom, withContractAction } from "./service/route-support";

export {
  TEST_MARKER,
  TEST_PHONE,
  createTestQuote,
  getTestQuote,
  runSeedTestQuoteJob,
  type CreateTestQuoteInput,
  type CreateTestQuoteResult,
} from "./service/test-support";
