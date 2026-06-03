import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getGfQuoteByShortId } from "@/lib/group-function-db";

/**
 * GET /api/portal/documents/{id}/pdf?token=...
 *
 * Redirect to the signed PDF URL.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const { id } = await params;

  try {
    const quote = await getGfQuoteByShortId(id);
    if (!quote) {
      return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
    }

    if (!quote.signed_pdf_url) {
      return NextResponse.json(
        { error: "No signed PDF available", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    return NextResponse.redirect(quote.signed_pdf_url);
  } catch (err) {
    console.error(`[portal/documents/${id}/pdf] Error:`, err);
    return NextResponse.json({ error: "Internal error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
