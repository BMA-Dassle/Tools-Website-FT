import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";

/**
 * Admin: mark sales_log rows as already-reconciled.
 *
 *   POST /api/admin/deposit-failures/mark-sales-reconciled?token=...
 *   Body: { billIds: string[] }
 *
 * Use case: staff manually fixed a customer's missing race-pack
 * credit via BMI Office before this retry queue existed. The
 * sales_log row still has `deposit_credit_pending=TRUE`, so the
 * Backfill button would re-enqueue it and the sweep cron would
 * double-credit. This endpoint flips that flag → FALSE so backfill
 * skips the row.
 *
 * Idempotent: re-flagging an already-reconciled row is a no-op.
 *
 * Safety: only flips rows that are currently `=TRUE`. Won't touch
 * rows where credits actually landed normally.
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

  let body: { billIds?: unknown };
  try {
    body = (await req.json()) as { billIds?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const billIds = Array.isArray(body.billIds)
    ? body.billIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (billIds.length === 0) {
    return NextResponse.json({ error: "billIds[] required" }, { status: 400 });
  }
  if (billIds.length > 200) {
    return NextResponse.json({ error: "max 200 billIds per request" }, { status: 400 });
  }

  const q = sql();
  const updated = (await q`
    UPDATE sales_log
    SET deposit_credit_pending = FALSE
    WHERE bill_id = ANY(${billIds}) AND deposit_credit_pending = TRUE
    RETURNING bill_id, deposit_person_id, deposit_amount
  `) as Array<{ bill_id: string; deposit_person_id: string | null; deposit_amount: number | null }>;

  console.log(
    `[mark-sales-reconciled] flipped ${updated.length} of ${billIds.length} requested billIds`,
  );

  return NextResponse.json({
    ok: true,
    updatedCount: updated.length,
    requestedCount: billIds.length,
    updated: updated.map((r) => ({
      billId: r.bill_id,
      personId: r.deposit_person_id,
      amount: r.deposit_amount,
    })),
  });
}
