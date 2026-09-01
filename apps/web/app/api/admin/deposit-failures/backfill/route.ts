import { NextRequest, NextResponse } from "next/server";
import { backfillFromSalesLog } from "@/lib/bmi-deposit-retry";
import { isDbConfigured } from "@/lib/db";
import { isAdminCredential } from "@/lib/admin-request-auth";

/**
 * Admin: import sales_log rows where deposit_credit_pending=TRUE into
 * the deposit-failures retry queue so the sweep cron starts retrying
 * them.
 *
 *   POST /api/admin/deposit-failures/backfill?token=...
 *
 * Idempotent — UPSERT on the unique key prevents duplicates. Safe to
 * run repeatedly during reconciliation.
 */

const LEGACY_TOKEN = process.env.ADMIN_ETICKETS_TOKEN || "";

/**
 * Defense in depth behind the middleware gate — see lib/admin-request-auth.
 * Accepts the static ADMIN_CAMERA_TOKEN (crons, scripts), a signed
 * short-lived token (what staff browsers now hold), or the SSO shell's
 * proxy key. Async because signature checks are Web Crypto.
 */
async function tokenOk(token: string): Promise<boolean> {
  // The legacy ADMIN_ETICKETS_TOKEN arm is untouched — its own rotation
  // retires it (see middleware.ts's 308 shim).
  return (await isAdminCredential(token)) || (!!LEGACY_TOKEN && token === LEGACY_TOKEN);
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (!(await tokenOk(token))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 500 });
  }
  const result = await backfillFromSalesLog();
  return NextResponse.json({ ok: true, ...result });
}
