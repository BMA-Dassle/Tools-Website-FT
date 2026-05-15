import { NextRequest, NextResponse } from "next/server";
import { backfillFromSalesLog } from "@/lib/bmi-deposit-retry";
import { isDbConfigured } from "@/lib/db";

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

const CACHE_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";
const LEGACY_TOKEN = process.env.ADMIN_ETICKETS_TOKEN || "";

function tokenOk(token: string): boolean {
  return (!!CACHE_TOKEN && token === CACHE_TOKEN) || (!!LEGACY_TOKEN && token === LEGACY_TOKEN);
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (!tokenOk(token)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 500 });
  }
  const result = await backfillFromSalesLog();
  return NextResponse.json({ ok: true, ...result });
}
