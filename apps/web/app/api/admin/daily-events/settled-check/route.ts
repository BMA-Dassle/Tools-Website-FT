import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getPosSettlementCheck } from "~/features/daily-events/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/daily-events/settled-check
 *       ?token=...&eventNumber=3253&when=<event ISO>&locationId=<BMI loc>
 *
 * POS settlement pickup for QUOTE-LESS events: finds a COMPLETED Square
 * check named "BMI <eventNumber>" near the event date at the center's
 * POS location(s). Quote-backed events don't need this — the
 * group-square-settled-close cron owns them. Lazy-loaded by the detail
 * view's Payments tab.
 */
export async function GET(req: NextRequest) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const eventNumber = (sp.get("eventNumber") || "").trim();
  const when = (sp.get("when") || "").trim();
  const locationId = parseInt(sp.get("locationId") || "", 10);
  if (!eventNumber || !when || Number.isNaN(locationId)) {
    return NextResponse.json(
      { success: false, error: "eventNumber, when, and locationId are required" },
      { status: 400 },
    );
  }

  try {
    const data = await getPosSettlementCheck({
      eventNumber,
      eventISO: when,
      bmiLocationId: locationId,
    });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Square lookup failed" },
      { status: 502 },
    );
  }
}
