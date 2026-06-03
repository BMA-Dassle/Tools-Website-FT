import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import { formatDocumentDetail } from "@/lib/portal-format";

/**
 * GET /api/portal/documents/{id}?token=...
 *
 * Full contract detail with line items.
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

    return NextResponse.json(formatDocumentDetail(quote));
  } catch (err) {
    console.error(`[portal/documents/${id}] Error:`, err);
    return NextResponse.json({ error: "Internal error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
