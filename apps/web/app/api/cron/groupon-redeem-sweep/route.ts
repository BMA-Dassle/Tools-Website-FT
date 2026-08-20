import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { runGrouponRedeemSweep } from "~/features/groupon/service/redeem-sweep.server";

/**
 * GET /api/cron/groupon-redeem-sweep — every 10 minutes (vercel.json).
 *
 * Closes the gap the safe ordering creates. A Groupon voucher is redeemed only
 * AFTER the guest's first item is actually delivered, so between those two
 * events we owe Groupon a notification we have not sent. Each `pending` row in
 * `groupon_units` is one of those debts; this drives them to `sent`.
 *
 * Nothing here is guest-facing and nothing here can cost a guest anything — the
 * worst case it repairs is a bookkeeping discrepancy with Groupon.
 *
 * Quiet by design: an empty queue is one indexed SELECT and no logging, so the
 * runs that DID something stay findable. Rows past 12 attempts are excluded
 * from the worklist (so they cannot starve it) and surfaced as `stalled`.
 *
 * ?dryRun=1 — report the worklist, send nothing.
 * ?limit=N  — cap rows examined this run.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;
  try {
    const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
    const limitRaw = req.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const result = await runGrouponRedeemSweep({
      dryRun,
      limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined,
    });

    if (result.redeemed.length || result.stillPending.length || result.stalled || !result.ok) {
      console.log("[cron/groupon-redeem-sweep]", JSON.stringify(result));
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[cron/groupon-redeem-sweep]", err);
    return NextResponse.json({ error: "groupon redeem sweep failed" }, { status: 500 });
  }
}
