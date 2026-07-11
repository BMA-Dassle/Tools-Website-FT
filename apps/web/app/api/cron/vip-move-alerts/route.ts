import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { vipMoveAlertsEnabled } from "~/features/vip-move-alerts/config";
import { runVipMoveAlerts } from "~/features/vip-move-alerts/run.server";

/**
 * GET /api/cron/vip-move-alerts — every minute (vercel.json).
 *
 * Posts "walk the guests over" Teams cards when a VIP combo party finishes a
 * leg at one center and their next step is at the other. Detection, combining
 * and anti-spam live in ~/features/vip-move-alerts.
 *
 * ?dryRun=1 — detect and report, but claim no dedup keys and send nothing.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;
  if (!vipMoveAlertsEnabled()) {
    return NextResponse.json({ ok: true, skipped: "flag off" });
  }
  try {
    const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
    return NextResponse.json(await runVipMoveAlerts({ dryRun }));
  } catch (err) {
    console.error("[cron/vip-move-alerts]", err);
    return NextResponse.json({ error: "vip-move-alerts failed" }, { status: 500 });
  }
}
