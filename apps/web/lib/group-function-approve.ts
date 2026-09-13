import {
  appendAuditLog,
  getGfQuoteByShortId,
  updateGfContractSent,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { sql } from "@/lib/db";
import { notifyContractSent, notifyPostPaidDenied } from "@/lib/group-function-notify";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

/**
 * THE post-paid approval rail, extracted from `app/api/group-function/approve/route.ts`
 * so there is exactly ONE implementation of what "approved" and "denied" DO.
 *
 * Two callers, one body (the brief's v2-alongside-v1 rule, R16):
 *
 *   - `POST /api/group-function/approve` — unchanged for the outside world,
 *     including its two-address `ALLOWED_APPROVERS` allowlist. It keeps
 *     deciding WHO may approve; this module decides WHAT approving does.
 *   - `POST /api/admin/crm/contracts/[shortId]/approve` — the CRM, which takes
 *     the approver from the signed-in SSO session (`requireCrmUser().email`)
 *     and never from a request body (R9).
 *
 * Neither the steps nor their order changed in the move: approved_at/by +
 * memo → `updateGfContractSent` → audit `postpaid_approved` → re-read →
 * `notifyContractSent` (fire-and-forget, as before) → BMI private note
 * (non-fatal) → portal webhook. Denial mirrors it.
 *
 * `approverEmail` is lowercased by the caller that authenticates it; this
 * module lowercases again so a stored value is never mixed-case.
 */

export class QuoteNotPendingApprovalError extends Error {
  readonly status: GroupFunctionQuote["status"];
  constructor(status: GroupFunctionQuote["status"]) {
    super(`Quote is in status: ${status}, not pending_approval`);
    this.name = "QuoteNotPendingApprovalError";
    this.status = status;
  }
}

export interface ApproveQuoteOptions {
  approverEmail: string;
  memo?: string | null;
}

export interface DenyQuoteOptions {
  approverEmail: string;
  reason: string;
}

export interface ApprovalOutcome {
  action: "approved" | "denied";
  quoteId: number;
  shortId: string | null;
  approverEmail: string;
}

/** Append a private note to the BMI project. Never fatal — the approval already landed. */
async function noteOnProject(quote: GroupFunctionQuote, note: string): Promise<void> {
  try {
    const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
    await appendProjectPrivateNote({
      centerCode: quote.center_code,
      projectId: quote.bmi_reservation_id,
      note: `[${noteTimestamp()}] ${note}`,
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Approve a post-paid contract and send it. Throws
 * `QuoteNotPendingApprovalError` when the quote has moved on — the caller
 * turns that into its own 400, exactly as the v1 route always did.
 */
export async function approveQuote(
  quote: GroupFunctionQuote,
  opts: ApproveQuoteOptions,
): Promise<ApprovalOutcome> {
  if (quote.status !== "pending_approval") throw new QuoteNotPendingApprovalError(quote.status);

  const approverEmail = opts.approverEmail.toLowerCase();
  const memo = opts.memo || null;
  const q = sql();

  await q`UPDATE group_function_quotes SET
      approved_at = NOW(),
      approved_by = ${approverEmail},
      approval_memo = ${memo},
      updated_at = NOW()
    WHERE id = ${quote.id}`;

  await updateGfContractSent(quote.id, {
    contract_short_id: quote.contract_short_id!,
    contract_status: "sent",
    contract_sent_at: new Date().toISOString(),
  });

  await appendAuditLog({
    quoteId: quote.id,
    event: "postpaid_approved",
    actorEmail: approverEmail,
    metadata: { memo },
  });

  // Re-read so the guest email carries the post-approval row, then send
  // WITHOUT awaiting — a SendGrid/Vox hiccup must not un-approve anything.
  if (quote.contract_short_id) {
    const updatedQuote = await getGfQuoteByShortId(quote.contract_short_id);
    if (updatedQuote) {
      notifyContractSent(updatedQuote).catch((err) =>
        console.error("[approve] notify error:", err),
      );
    }
  }

  await noteOnProject(
    quote,
    `Post-paid approved by ${approverEmail}${memo ? ` | Memo: ${memo}` : ""}`,
  );

  firePortalWebhookAsync("approval.approved", {
    documentId: quote.contract_short_id,
    bmiCode: quote.bmi_reservation_id,
    venue: quote.center_code,
    status: "contract_sent",
  });

  console.log(`[approve] approved quote=${quote.id} by ${approverEmail}`);
  return {
    action: "approved",
    quoteId: quote.id,
    shortId: quote.contract_short_id,
    approverEmail,
  };
}

/** Deny a post-paid contract; the planner is notified with the reason. */
export async function denyQuote(
  quote: GroupFunctionQuote,
  opts: DenyQuoteOptions,
): Promise<ApprovalOutcome> {
  if (quote.status !== "pending_approval") throw new QuoteNotPendingApprovalError(quote.status);

  const approverEmail = opts.approverEmail.toLowerCase();
  const reason = opts.reason;
  const q = sql();

  await q`UPDATE group_function_quotes SET
      denied_at = NOW(),
      denied_by = ${approverEmail},
      denial_reason = ${reason},
      status = 'denied',
      updated_at = NOW()
    WHERE id = ${quote.id}`;

  await appendAuditLog({
    quoteId: quote.id,
    event: "postpaid_denied",
    actorEmail: approverEmail,
    metadata: { reason },
  });

  if (quote.contract_short_id) {
    const deniedQuote = await getGfQuoteByShortId(quote.contract_short_id);
    if (deniedQuote) {
      notifyPostPaidDenied(deniedQuote).catch((err) =>
        console.error("[approve] deny notify error:", err),
      );
    }
  }

  await noteOnProject(quote, `Post-paid denied by ${approverEmail} | Reason: ${reason}`);

  firePortalWebhookAsync("document.denied", {
    documentId: quote.contract_short_id,
    bmiCode: quote.bmi_reservation_id,
    venue: quote.center_code,
    status: "denied",
  });

  console.log(`[approve] denied quote=${quote.id} by ${approverEmail}: ${reason}`);
  return { action: "denied", quoteId: quote.id, shortId: quote.contract_short_id, approverEmail };
}
