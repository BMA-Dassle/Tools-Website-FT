import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { sweepUnfulfilledDealPurchases } from "~/features/deals/service/reconcile";

/**
 * GET /api/cron/deal-voucher-reconcile
 *
 * Forward-recovery for prepaid deal packs. The purchase path soft-fails
 * everything after the capture — a mint or email hiccup must never show an error
 * to somebody whose card already went through — which means a paid purchase can
 * legitimately exist with no vouchers cut, or with vouchers but no email sent.
 * This finishes both.
 *
 * Idempotent by construction: the mint is fenced by a conditional UPDATE on
 * `deal_purchases.voucher_batch_id IS NULL`, so a re-run (or a race with the
 * live request) mints nothing new and voids anything surplus. `?dryRun=1`
 * reports without mutating.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  try {
    const summary = await sweepUnfulfilledDealPurchases({ dryRun });
    return NextResponse.json({ ok: true, dryRun, ...summary });
  } catch (err) {
    console.error("[deal-voucher-reconcile] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sweep failed" },
      { status: 500 },
    );
  }
}
