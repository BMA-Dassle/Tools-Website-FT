import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getPaymentDetailByCode, getPaymentsBulkByCodes } from "~/features/daily-events/service";

export const dynamic = "force-dynamic";

const MAX_CODES = 60;

/**
 * GET /api/admin/daily-events/payments?token=...&bmiCodes=a,b,c
 * GET /api/admin/daily-events/payments?token=...&bmiCode=a
 *
 * Website payment status per BMI projectId — the same group_function_quotes
 * lookup the portal reached through /api/portal/payments, served directly
 * now that the page lives on the website. Response shapes mirror the
 * portal's /api/integrations/website-payments proxy so the moved UI
 * service keeps working unchanged: bulk → {success, results}, single →
 * {success, result}.
 */
export async function GET(req: NextRequest) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const { searchParams } = req.nextUrl;
  const bmiCodes = searchParams.get("bmiCodes");
  const bmiCode = searchParams.get("bmiCode");

  try {
    if (bmiCodes !== null) {
      const codes = bmiCodes
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, MAX_CODES);
      const results = await getPaymentsBulkByCodes(codes);
      return NextResponse.json({ success: true, results });
    }

    if (bmiCode) {
      // Detail view — richer shape (payment entries, balance link, attempts)
      const result = await getPaymentDetailByCode(bmiCode.trim());
      return NextResponse.json({ success: true, result });
    }

    return NextResponse.json(
      { success: false, error: "bmiCodes or bmiCode is required" },
      { status: 400 },
    );
  } catch (error) {
    console.error("[daily-events] payments error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
