import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { runStampBackfill } from "~/features/reservation-edit/stamp-backfill";

/**
 * POST /api/admin/bowling/backfill-pricing-stamp?token=...
 *
 * Derives the booking_metadata.bowling pricing stamp for reservations booked
 * before the reservation-edit branch introduced it (all pre-branch rows), so
 * player/lane/duration edits stop falling back to carry mode. Rows that
 * can't derive are skipped with a reason — inspect them before a live run.
 *
 * Auth: ADMIN_CAMERA_TOKEN query param.
 *
 * Body (optional):
 *   { dryRun?: boolean,   — default TRUE: report proposed stamps, write nothing
 *     limit?: number,     — batch size, default 200 (newest-created rows first)
 *     beforeId?: number,  — keyset cursor: previous response's nextBeforeId
 *     neonId?: number }   — single-row mode for spot repairs
 */

// Batches walk up to `limit` rows with per-row line loads — well past the
// default function budget.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    dryRun?: boolean;
    limit?: number;
    neonId?: number;
    beforeId?: number;
  };

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 });
  }

  const result = await runStampBackfill({
    dryRun: body.dryRun !== false,
    limit:
      typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit > 0
        ? Math.min(body.limit, 1000)
        : 200,
    neonId: typeof body.neonId === "number" ? body.neonId : null,
    beforeId: typeof body.beforeId === "number" ? body.beforeId : null,
  });

  return NextResponse.json({ ok: true, ...result });
}
