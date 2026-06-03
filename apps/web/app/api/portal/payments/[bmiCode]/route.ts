import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getGfQuoteByReservationId } from "@/lib/group-function-db";
import { formatPaymentDetail } from "@/lib/portal-format";

/**
 * GET /api/portal/payments/{bmiCode}?token=...
 *
 * Single event payment detail.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ bmiCode: string }> }) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const { bmiCode } = await params;

  try {
    const quote = await getGfQuoteByReservationId(bmiCode);
    if (!quote) {
      return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
    }

    return NextResponse.json(formatPaymentDetail(quote));
  } catch (err) {
    console.error(`[portal/payments/${bmiCode}] Error:`, err);
    return NextResponse.json({ error: "Internal error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
