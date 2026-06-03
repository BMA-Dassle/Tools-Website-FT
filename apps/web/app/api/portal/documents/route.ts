import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getGfQuoteByReservationId } from "@/lib/group-function-db";
import { formatDocumentSummary } from "@/lib/portal-format";

/**
 * GET /api/portal/documents?token=...&bmiCode={code}
 *
 * Find contracts for an event by BMI code.
 */
export async function GET(req: NextRequest) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const bmiCode = req.nextUrl.searchParams.get("bmiCode") || "";
  if (!bmiCode) {
    return NextResponse.json(
      { error: "bmiCode query param required", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  try {
    const quote = await getGfQuoteByReservationId(bmiCode);
    if (!quote || !quote.contract_short_id) {
      return NextResponse.json({ documents: [] });
    }

    return NextResponse.json({
      documents: [formatDocumentSummary(quote)],
    });
  } catch (err) {
    console.error("[portal/documents] Error:", err);
    return NextResponse.json({ error: "Internal error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
