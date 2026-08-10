import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { kioskTenderSweepEnabled } from "~/features/kiosk/flags";
import { runKioskTenderSweep } from "~/features/kiosk/service/tender-sweep.server";

/**
 * GET /api/cron/kiosk-tender-sweep — every 10 min (vercel.json).
 *
 * Drains stale open kiosk payment sessions left by the ambient gift-card
 * rail's auth-then-capture shape: forward-captures sets that cover their
 * total, voids abandoned holds (verified), and records
 * captured-but-unfinalized orders — anything needing human eyes lands in the
 * ledger as needs_review. See ~/features/kiosk/service/tender-sweep.server.ts.
 *
 * ?dryRun=1 — classify and report; mutate nothing.
 * ?token=   — ADMIN_CAMERA_TOKEN for a manual run outside the cron.
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
  if (!kioskTenderSweepEnabled()) {
    return NextResponse.json({ ok: true, skipped: "flag off" });
  }
  try {
    const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
    return NextResponse.json(await runKioskTenderSweep({ dryRun }));
  } catch (err) {
    console.error("[cron/kiosk-tender-sweep]", err);
    return NextResponse.json({ error: "kiosk-tender-sweep failed" }, { status: 500 });
  }
}
