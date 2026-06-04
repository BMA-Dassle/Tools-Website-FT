import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getGfQuoteByShortId } from "@/lib/group-function-db";

/**
 * Lightweight quote status endpoint for contract page polling.
 *
 * GET /api/group-function/quote-status?shortId=...
 *
 * Returns current quote state + a hash of line items so the client
 * can detect changes without transferring the full product list.
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

  const lineItemsHash = createHash("md5")
    .update(JSON.stringify(quote.line_items))
    .digest("hex")
    .slice(0, 12);

  return NextResponse.json({
    status: quote.status,
    contractStatus: quote.contract_status,
    depositPaidAt: quote.deposit_paid_at,
    totalCents: quote.total_cents,
    taxCents: quote.tax_cents,
    depositDueCents: quote.deposit_due_cents,
    balanceCents: quote.balance_cents,
    eventName: quote.event_name,
    eventDateDisplay: quote.event_date_display,
    notes: quote.notes,
    lineItemsHash,
    signedPdfUrl: quote.signed_pdf_url,
    savedCardLast4: quote.saved_card_last4,
    savedCardBrand: quote.saved_card_brand,
    updatedAt: quote.updated_at,
  });
}
