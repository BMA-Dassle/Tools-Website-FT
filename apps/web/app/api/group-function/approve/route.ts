import { NextRequest, NextResponse } from "next/server";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import {
  QuoteNotPendingApprovalError,
  approveQuote,
  denyQuote,
} from "@/lib/group-function-approve";

/**
 * POST /api/group-function/approve
 *
 * Approve or deny a post-paid group function contract.
 * Body: { shortId, action: "approve" | "deny", email, reason? }
 *
 * Only pending_approval quotes can be approved/denied.
 * Approve: sends the contract to the customer.
 * Deny: emails the planner with the reason, CCs management.
 *
 * v1 SURFACE, UNCHANGED (brief R16): this route keeps its own two-address
 * allowlist and its request/response shapes. What approving DOES now lives in
 * `lib/group-function-approve.ts`, shared with the CRM's approve route — which
 * takes its approver from the signed-in SSO session instead of the body.
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

  if (action === "deny" && !reason) {
    return NextResponse.json({ error: "reason required for denial" }, { status: 400 });
  }

  try {
    if (action === "approve") {
      await approveQuote(quote, { approverEmail, memo });
      return NextResponse.json({ ok: true, action: "approved" });
    }
    await denyQuote(quote, { approverEmail, reason: reason! });
    return NextResponse.json({ ok: true, action: "denied" });
  } catch (err) {
    if (err instanceof QuoteNotPendingApprovalError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
