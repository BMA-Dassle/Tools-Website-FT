import { NextRequest, NextResponse } from "next/server";
import { isAdminCredential } from "@/lib/admin-request-auth";
import { verifyCron } from "@/lib/cron-auth";
import { ensureCrmSchema } from "~/features/crm/core/schema";
import { drainDueJobs } from "~/features/crm/jobs";

/**
 * GET /api/cron/crm-jobs — every 2 minutes (the ONE CRM cron, brief §3.9).
 *
 * Drains due `crm_jobs` rows through `HANDLERS[kind]`: lease 120 s, batch 50,
 * 45 s deadline (rows leased but not reached are released untouched).
 *
 * AUTH IS TOKEN-FIRST (R15), the same order as `bmi-sync-queue/route.ts:70-76`:
 * `verifyCron` returns `{skipped:"not production"}` on EVERY preview before it
 * reads anything, so checking it first would make a manual run impossible
 * exactly where manual runs are needed. `isAdminCredential` accepts the
 * browser-minted 8 h token as well as the static one, so a director can
 * trigger a drain from the Statuses screen without `ADMIN_CAMERA_TOKEN` ever
 * reaching a client (that is the one difference from the bmi-sync-queue copy,
 * which compares the static token alone).
 *
 * `maxDuration = 60`: the 45 s drain deadline exceeds the default timeout.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const manual = await isAdminCredential(req.nextUrl.searchParams.get("token"));
  if (!manual) {
    const denied = verifyCron(req);
    if (denied) return denied;
  }

  await ensureCrmSchema();
  const started = Date.now();
  const summary = await drainDueJobs();
  console.log(
    `[crm-jobs] leased=${summary.leased} ran=${summary.ran} done=${summary.done} ` +
      `retry=${summary.retry} parked=${summary.parked} deferred=${summary.deferred} ` +
      `in ${Date.now() - started}ms`,
  );
  return NextResponse.json(
    { ok: true, manual, ...summary },
    { headers: { "cache-control": "no-store" } },
  );
}
