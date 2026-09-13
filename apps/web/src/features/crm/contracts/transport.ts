/**
 * The contracts sub's ONE door to the old code (brief §3.2: "Old code in
 * `apps/web/lib/*` is imported by the `bmi`, `sms`, `contracts` transport files
 * only"). Every other file in this sub imports from here, so the surface the
 * CRM depends on is a list you can read in one screen — and so a change to a
 * v1 signature breaks in one place rather than nine.
 *
 * Nothing is re-implemented here. `group_function_quotes`, its audit ledger,
 * the notification ledger, the reminder rules, the day-of order builder and
 * the Square timeline all keep their single owners; the CRM is a second
 * CALLER, never a second writer (R16 v2-alongside-v1).
 */

export {
  appendAuditLog,
  diffSnapshots,
  diffVersionsAgainstLive,
  ensureGfSchema,
  extractContractSnapshot,
  getAuditLog,
  getContractVersions,
  getEventNotifications,
  getGfQuoteByReservationId,
  getGfQuoteByShortId,
  recordEventNotification,
  updateGfQuoteDetails,
  type AuditLogEntry,
  type ContractVersion,
  type EventNotification,
  type FieldDiff,
  type GfQuoteStatus,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";

export {
  QuoteNotPendingApprovalError,
  approveQuote,
  denyQuote,
  type ApprovalOutcome,
} from "@/lib/group-function-approve";

export {
  chargeBalanceForQuote,
  type BalanceChargeOutcome,
  type ChargeBalanceOptions,
} from "@/lib/group-balance-charge";

export { notifyContractSent } from "@/lib/group-function-notify";

export { RULES, eventWaiverLinkUrl, type RuleContext } from "@/lib/group-event-rules";

export { createDayofOrder } from "@/lib/group-function-dayof";

export {
  appendProjectPrivateNote,
  fetchProjectRawIds,
  noteTimestamp,
  setProjectState,
} from "@/lib/bmi-office-actions";

export { getContractHistory, getSquareTimeline } from "~/features/daily-events/service";

/**
 * The LIVE project read behind "what the guest sees". `officeGet` underneath,
 * so the 17-digit ids in the payload come back through `parseWithRawIds` as
 * strings — never `res.json()`, never `JSON.parse`, which is how the
 * production off-by-one happened.
 */
export { fetchProjectRaw } from "~/features/daily-events/data/bmi-office";
