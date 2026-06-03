import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { ensureGfSchema } from "@/lib/group-function-db";
import { sql } from "@/lib/db";

/**
 * GET /api/portal/documents/changed?token=...&since={ISO}&limit=50&offset=0
 *
 * Backfill — documents modified since a timestamp.
 * Returns lightweight stubs; portal fetches full detail via /documents/{id}.
 */
export async function GET(req: NextRequest) {
  const denied = verifyPortal(req);
  if (denied) return denied;

  const since = req.nextUrl.searchParams.get("since") || "";
  if (!since) {
    return NextResponse.json(
      { error: "since query param required (ISO 8601)", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) {
    return NextResponse.json(
      { error: "Invalid date format for since", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const limit = Math.min(Math.max(1, Number(req.nextUrl.searchParams.get("limit") || "50")), 200);
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") || "0"));

  try {
    await ensureGfSchema();
    const q = sql();

    const countResult = await q`
      SELECT COUNT(*)::int AS total
      FROM group_function_quotes
      WHERE updated_at > ${sinceDate.toISOString()}::timestamptz
        AND contract_short_id IS NOT NULL
    `;
    const total = (countResult[0] as { total: number })?.total ?? 0;

    const rows = await q`
      SELECT
        contract_short_id,
        bmi_reservation_id,
        center_code,
        status,
        updated_at
      FROM group_function_quotes
      WHERE updated_at > ${sinceDate.toISOString()}::timestamptz
        AND contract_short_id IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    const documents = (
      rows as Array<{
        contract_short_id: string;
        bmi_reservation_id: string;
        center_code: string;
        status: string;
        updated_at: string;
      }>
    ).map((r) => ({
      id: r.contract_short_id,
      bmiCode: r.bmi_reservation_id,
      venue: r.center_code,
      status: r.status,
      dateModified: r.updated_at,
    }));

    return NextResponse.json({
      documents,
      total,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("[portal/documents/changed] Error:", err);
    return NextResponse.json({ error: "Internal error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
