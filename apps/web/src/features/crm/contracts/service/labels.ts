/**
 * Human labels for the contract audit ledger and the notification ledger.
 *
 * The prototype's two maps (`auditLabel`, `crm-events.js:175`; `ruleLabel`,
 * `crm-events.js:96`) are here VERBATIM, plus the event keys the real ledger
 * actually writes, which the prototype's seed never had to name
 * (`postpaid_approved`, `balance_declined`, the reminder cron's `rem_*` gates).
 * Anything unmapped is humanised rather than hidden — an unlabelled ledger row
 * is still a fact about the contract, and swallowing it is how a failure goes
 * unnoticed.
 *
 * PURE: no clock, no database, no React.
 */

/** `crm-events.js:175` first, then the events the live ledger writes. */
export const AUDIT_LABEL: Record<string, string> = {
  // ── prototype, verbatim ──
  contract_sent: "Contract sent (email + text)",
  contract_updated: "Contract updated — new version sent",
  page_view: "Guest opened the contract page",
  resend_contract: "Contract resent",
  signed: "Contract signed",
  deposit_paid: "Deposit paid",
  waiver_reminder: "Waiver reminder sent",
  "96hr_reminder": "96-hour reminder sent",
  balance_charged: "Balance charged",
  balance_link_sent: "Balance payment link sent",
  approval_needed: "Approval requested from management",
  approved: "Post-paid approved",
  denied: "Post-paid denied",
  cancelled: "Event cancelled — refund issued",
  // ── the live ledger's own keys ──
  postpaid_approved: "Post-paid approved",
  postpaid_denied: "Post-paid denied",
  balance_declined: "Balance card declined",
  balance_payment_failed: "Balance charge failed",
  legacy_winback_ingested: "Win-back offer ingested",
  winback_incentive_issued: "Win-back incentive issued",
  pdf_archived: "Signed PDF archived",
};

/** `crm-events.js:96` — the guest-message rules, by ledger key. */
export const NOTIFICATION_RULE_LABEL: Record<string, string> = {
  contract_sent: "Contract sent",
  contract_updated: "Contract updated",
  deposit_paid: "Deposit receipt",
  "96hr_reminder": "96-hour verify details",
  "7day_waiver": "7-day waiver reminder",
  balance_charge: "Balance auto-charge (T-72h)",
  balance_receipt: "Balance receipt",
  thank_you: "Thank you",
  approval_needed: "Approval needed (to management)",
  resign_48: "Re-sign reminder 48 h",
  resign_24: "Re-sign final notice",
};

/** "balance_link_sent" → "Balance link sent"; "rem_7day_waiver:2" → "Reminder sent — 7day waiver". */
export function humaniseEvent(event: string): string {
  if (event.startsWith("rem_")) {
    return `Reminder sent — ${event.slice(4).replace(/:\d+$/, "").replace(/_/g, " ")}`;
  }
  const words = event.replace(/[_:]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function auditLabel(event: string): string {
  return AUDIT_LABEL[event] ?? humaniseEvent(event);
}

export function notificationRuleLabel(ruleKey: string): string {
  return NOTIFICATION_RULE_LABEL[ruleKey] ?? humaniseEvent(ruleKey);
}

/**
 * A short detail line from an audit row's metadata — the same fields the
 * reservations-admin timeline pulls out, so the two boards say the same thing
 * about the same row.
 */
export function auditDetail(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.reason === "string" && m.reason) parts.push(m.reason);
  if (typeof m.memo === "string" && m.memo) parts.push(m.memo);
  if (typeof m.code === "string" && m.code && m.code !== "UNKNOWN") parts.push(m.code);
  if (typeof m.error === "string" && m.error) parts.push(m.error);
  if (typeof m.amountCents === "number") parts.push(`$${(m.amountCents / 100).toFixed(2)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The Guest-messages card's footer (crm-events.js:100), verbatim. */
export const GUEST_MESSAGES_FOOTER =
  "Automatic: contract sent · contract updated · 96-hour verify · 7-day waiver · balance receipt · thank-you. " +
  "A failed rule is silenced for this event until you fire it by hand.";

/** The Contracts screen's footer (crm-events.js:234), verbatim. */
export const CONTRACTS_FOOTER =
  'Automatic behind the scenes: BMI "Send Contract" creates and sends · deposit paid flips BMI to Confirmation · ' +
  'balance charges 72 h out · day-of order pays from the gift card and closes after the event · BMI "Cancellation" refunds. ' +
  "Failures show up in Needs attention, never silently.";
