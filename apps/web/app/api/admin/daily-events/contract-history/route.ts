import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { getContractHistory } from "~/features/daily-events/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/daily-events/contract-history?token=...&projectId=...
 *
 * Merged contract timeline for an event's group-function quote: the
 * immutable contract_audit_log, contract_versions revisions, archived
 * signed PDFs, and quote milestone timestamps. Empty array when the event
 * has no website quote. Lazy-loaded by the detail view's Contract tab.
 */
export async function GET(req: NextRequest) {
  const denied = await verifyPortal(req);
  if (denied) return denied;

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ success: false, error: "projectId is required" }, { status: 400 });
  }

  try {
    const data = await getContractHistory(projectId.trim());
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[daily-events] contract-history error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
