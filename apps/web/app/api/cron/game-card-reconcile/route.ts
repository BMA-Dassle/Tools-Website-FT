import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { reconcilePendingLoads } from "~/features/game-cards/service/reconcile";

/**
 * GET /api/cron/game-card-reconcile
 *
 * Forward-recovery for game-card reloads: sweeps the bridge queue (stale
 * queued → SOAP fallback; expired claims → verify; verify rows resolved from
 * cloud history or flagged manual), then replays the cloud SOAP load for
 * every SOAP-eligible charged-but-unloaded row using its stored (dedup-safe)
 * tpi_transaction_id. `?dryRun=1` reports what would run without mutating.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  try {
    const summary = await reconcilePendingLoads(dryRun);
    return NextResponse.json({ ok: true, dryRun, ...summary });
  } catch (err) {
    console.error("[game-card-reconcile] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "reconcile failed" },
      { status: 500 },
    );
  }
}
