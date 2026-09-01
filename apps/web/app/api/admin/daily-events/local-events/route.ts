import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getLocalDayEvents } from "~/features/daily-events/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/daily-events/local-events
 *       ?token=...&locationId=332160&dates=2026-07-22,2026-07-23,...
 *
 * Phase 1 of the board load: every quote-backed event for the requested
 * dates straight from OUR DB (group_function_quotes) with its payment
 * summary — no BMI round trip. The board paints these instantly, then the
 * per-date BMI fetches replace each day with office truth (adding any
 * quote-less/legacy events).
 */
export async function GET(req: NextRequest) {
  const denied = await verifyPortal(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const locationId = parseInt(sp.get("locationId") || "", 10);
  const dates = (sp.get("dates") || "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .slice(0, 31);
  if (Number.isNaN(locationId) || dates.length === 0) {
    return NextResponse.json(
      { success: false, error: "locationId and dates are required" },
      { status: 400 },
    );
  }

  try {
    const data = await getLocalDayEvents(dates, locationId);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "local lookup failed" },
      { status: 500 },
    );
  }
}
