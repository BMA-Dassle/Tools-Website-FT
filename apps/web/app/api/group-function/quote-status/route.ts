import { NextRequest, NextResponse } from "next/server";
import { getGfQuoteByShortId } from "@/lib/group-function-db";

/**
 * Lightweight quote status endpoint for contract page polling.
 *
 * GET /api/group-function/quote-status?shortId=...
 *
 * Returns the current PandaDoc document ID and status so the page
 * can detect when the contract has been updated (voided + re-created)
 * and reload to show the new document.
 */

export async function GET(req: NextRequest) {
  const shortId = req.nextUrl.searchParams.get("shortId");
  if (!shortId) {
    return NextResponse.json({ error: "shortId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    pandadocDocumentId: quote.pandadoc_document_id,
    contractStatus: quote.contract_status,
    status: quote.status,
    depositPaidAt: quote.deposit_paid_at,
    totalCents: quote.total_cents,
    depositDueCents: quote.deposit_due_cents,
    balanceCents: quote.balance_cents,
    updatedAt: quote.updated_at,
  });
}
