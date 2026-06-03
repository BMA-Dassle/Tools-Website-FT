import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getGfQuoteByReservationId } from "@/lib/group-function-db";
import { formatPaymentSummary } from "@/lib/portal-format";

/**
 * GET /api/portal/payments?token=...&bmiCodes=3288,3312,3290
 *
 * Bulk payment lookup for portal list views.
 * Up to 30 BMI codes per request.
 * Codes with no website record are omitted from results.
 */
export async function GET(req: NextRequest) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const raw = req.nextUrl.searchParams.get("bmiCodes") || "";
  const bmiCodes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (bmiCodes.length === 0) {
    return NextResponse.json(
      { error: "bmiCodes query param required", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }
  if (bmiCodes.length > 30) {
    return NextResponse.json(
      { error: "Maximum 30 BMI codes per request", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  try {
    const results = await Promise.all(
      bmiCodes.map(async (code) => {
        const quote = await getGfQuoteByReservationId(code);
        if (!quote) return null;
        return formatPaymentSummary(quote);
      }),
    );

    return NextResponse.json({
      results: results.filter(Boolean),
    });
  } catch (err) {
    console.error("[portal/payments] Error:", err);
    return NextResponse.json({ error: "Internal error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
