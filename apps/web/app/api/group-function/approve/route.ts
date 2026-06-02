import { NextRequest, NextResponse } from "next/server";
import {
  getGfQuoteByShortId,
  updateGfContractSent,
  updateGfQuoteDetails,
  appendAuditLog,
} from "@/lib/group-function-db";
import { sql } from "@/lib/db";
import { notifyContractSent, notifyPostPaidDenied } from "@/lib/group-function-notify";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

/**
 * POST /api/group-function/approve
 *
 * Approve or deny a post-paid group function contract.
 * Body: { shortId, action: "approve" | "deny", email, reason? }
 *
 * Only pending_approval quotes can be approved/denied.
 * Approve: sends the contract to the customer.
 * Deny: emails the planner with the reason, CCs management.
 */

const ALLOWED_APPROVERS = ["eric@headpinz.com", "jacob@headpinz.com"];

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { shortId, action, email, reason, memo } = body as {
    shortId: string;
    action: "approve" | "deny";
    email?: string;
    reason?: string;
    memo?: string;
  };

  if (!shortId || !action) {
    return NextResponse.json({ error: "shortId and action required" }, { status: 400 });
  }

  if (action !== "approve" && action !== "deny") {
    return NextResponse.json({ error: "action must be approve or deny" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  if (quote.status !== "pending_approval") {
    return NextResponse.json(
      { error: `Quote is in status: ${quote.status}, not pending_approval` },
      { status: 400 },
    );
  }

  const approverEmail = (email || "").toLowerCase();
  if (!ALLOWED_APPROVERS.includes(approverEmail)) {
    return NextResponse.json({ error: "Not authorized to approve/deny" }, { status: 403 });
  }

  const q = sql();

  if (action === "approve") {
    await q`UPDATE group_function_quotes SET
      approved_at = NOW(),
      approved_by = ${approverEmail},
      approval_memo = ${memo || null},
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
      metadata: { memo: memo || null },
    });

    const updatedQuote = await getGfQuoteByShortId(shortId);
    if (updatedQuote) {
      notifyContractSent(updatedQuote).catch((err) =>
        console.error("[approve] notify error:", err),
      );
    }

    try {
      const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
      await appendProjectPrivateNote({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        note: `[${noteTimestamp()}] Post-paid approved by ${approverEmail}${memo ? ` | Memo: ${memo}` : ""}`,
      });
    } catch {
      /* non-fatal */
    }

    firePortalWebhookAsync("approval.approved", {
      documentId: quote.contract_short_id,
      bmiCode: quote.bmi_reservation_id,
      venue: quote.center_code,
      status: "contract_sent",
    });

    console.log(`[approve] approved quote=${quote.id} by ${approverEmail}`);
    return NextResponse.json({ ok: true, action: "approved" });
  }

  // Deny
  if (!reason) {
    return NextResponse.json({ error: "reason required for denial" }, { status: 400 });
  }

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

  const deniedQuote = await getGfQuoteByShortId(shortId);
  if (deniedQuote) {
    notifyPostPaidDenied(deniedQuote).catch((err) =>
      console.error("[approve] deny notify error:", err),
    );
  }

  try {
    const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
    await appendProjectPrivateNote({
      centerCode: quote.center_code,
      projectId: quote.bmi_reservation_id,
      note: `[${noteTimestamp()}] Post-paid denied by ${approverEmail} | Reason: ${reason}`,
    });
  } catch {
    /* non-fatal */
  }

  firePortalWebhookAsync("document.denied", {
    documentId: quote.contract_short_id,
    bmiCode: quote.bmi_reservation_id,
    venue: quote.center_code,
    status: "denied",
  });

  console.log(`[approve] denied quote=${quote.id} by ${approverEmail}: ${reason}`);
  return NextResponse.json({ ok: true, action: "denied" });
}
