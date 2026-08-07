import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { reconcileLicencePasses } from "~/features/racing/wallet/licence-reconcile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Daily: work out which racing licences are actually on a phone, and delete the
 * PassKit records for the ones that are not.
 *
 * THIS IS A BILLING JOB. A multi-use pass is re-billed every month it stays
 * alive and the 250-free allowance is a standing cap on live records, so a pass
 * nobody installed costs us indefinitely for nothing. Deleting the record is
 * the only lever — and unlike a single-use coupon (DELETE is 501), a member
 * really can be deleted.
 *
 * DRY RUN IS THE DEFAULT-SAFE WAY IN. `?dryRun=1` reports exactly what it would
 * delete and touches nothing. Run it that way until the numbers look right;
 * these are real guests' credentials and a bad reap takes a licence out of
 * someone's wallet.
 *
 * Daily rather than hourly on purpose: install state changes slowly, the grace
 * window is measured in days, and one read per pass per day is a rounding error
 * against the monthly fee it protects.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();

  try {
    const stats = await reconcileLicencePasses({ dryRun });

    // An unrecognised status is how a reaper quietly stops reaping — PassKit
    // adding a value we do not match would look identical to "everything is
    // installed". Log it loudly rather than leaving it in a JSON response
    // nobody reads.
    if (stats.unknown.length > 0) {
      console.warn(
        `[passkit-reconcile] UNRECOGNISED pass statuses: ${stats.unknown.join(", ")} — the reaper skipped these`,
      );
    }
    if (stats.reaped > 0) {
      console.log(
        `[passkit-reconcile] ${dryRun ? "WOULD reap" : "reaped"} ${stats.reaped} pass(es); ${stats.installed} installed, ${stats.awaitingInstall} awaiting install`,
      );
    }

    return NextResponse.json(
      { ok: true, dryRun, ms: Date.now() - started, ...stats },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[passkit-reconcile] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
