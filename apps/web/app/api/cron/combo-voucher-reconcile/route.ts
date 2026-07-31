import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { sweepMissingComboVouchers } from "~/features/combos/combo-voucher";

/**
 * GET /api/cron/combo-voucher-reconcile
 *
 * Forward-recovery for the combo voucher grant: the reserve-time mint is
 * soft-fail (a captured booking must never fail on it), so any recent combo
 * booking whose combo grants a voucher but whose bill has no vouchers row is
 * minted here and the guest is emailed the code as a make-good (their
 * confirmation email went out without it). Idempotent — the bill_id unique
 * link means re-runs mint nothing new. `?dryRun=1` reports without mutating.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Look-back window. Wide enough to ride out a long Neon/SendGrid incident;
 *  bounded so the sweep never crawls all of history. */
const SWEEP_SINCE_DAYS = 7;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  try {
    const summary = await sweepMissingComboVouchers({ sinceDays: SWEEP_SINCE_DAYS, dryRun });
    return NextResponse.json({ ok: true, dryRun, ...summary });
  } catch (err) {
    console.error("[combo-voucher-reconcile] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sweep failed" },
      { status: 500 },
    );
  }
}
