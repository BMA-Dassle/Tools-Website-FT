import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { refundAlertsEnabled } from "~/features/refund-alerts/config";
import { runRefundAlerts } from "~/features/refund-alerts/run.server";

/**
 * GET /api/cron/refund-alerts — every 5 min (vercel.json).
 *
 * Detects refunds issued directly in Square (Dashboard/POS) on
 * reservation-linked payments — bypassing the Reservation Portal — and calls
 * them out in the call-center Teams chat. Detection and anti-spam live in
 * ~/features/refund-alerts.
 *
 * ?dryRun=1  — detect and report, but claim no dedup keys and send nothing.
 * ?token=    — ADMIN_CAMERA_TOKEN for a manual run outside the cron.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const denied = verifyCron(req);
    if (denied) return denied;
  }
  if (!refundAlertsEnabled()) {
    return NextResponse.json({ ok: true, skipped: "flag off" });
  }
  try {
    const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
    return NextResponse.json(await runRefundAlerts({ dryRun }));
  } catch (err) {
    console.error("[cron/refund-alerts]", err);
    return NextResponse.json({ error: "refund-alerts failed" }, { status: 500 });
  }
}
