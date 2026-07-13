import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getSquareTimeline } from "~/features/daily-events/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/daily-events/square-timeline?token=...&projectId=...
 *
 * Live Square facts for an event's group-function quote: deposit order
 * (+ tender payment statuses), funding gift card (live state/balance),
 * balance order, day-of / settled orders. Empty array when the event has
 * no website quote. Lazy-loaded by the detail view's Payments tab.
 */
export async function GET(req: NextRequest) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ success: false, error: "projectId is required" }, { status: 400 });
  }

  try {
    const data = await getSquareTimeline(projectId.trim());
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[daily-events] square-timeline error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
