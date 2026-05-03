import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { summarizeFailures } from "@/lib/bmi-deposit-retry";

/**
 * Admin: list BMI deposit failures.
 *
 *   GET /api/admin/deposit-failures/list
 *       &token=...                 — admin token gate
 *       &include=unresolved        — default: only unresolved rows
 *       &include=all               — both unresolved + recently resolved (last 7d)
 *
 * Token-gated via the same ADMIN_CAMERA_TOKEN that fronts e-tickets
 * + sales. Returns full row data + a summary block for the dashboard
 * chip ("12 unresolved, oldest 3 days ago, sum $640 in race packs").
 */

const CACHE_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";
const LEGACY_TOKEN = process.env.ADMIN_ETICKETS_TOKEN || "";

function tokenOk(token: string): boolean {
  return (!!CACHE_TOKEN && token === CACHE_TOKEN) || (!!LEGACY_TOKEN && token === LEGACY_TOKEN);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (!tokenOk(token)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 500 });
  }

  const include = url.searchParams.get("include") || "unresolved";
  const q = sql();

  // Read all the rows we want to surface. Two separate queries — one
  // for unresolved (always returned), one for recently-resolved
  // (only when include=all). Frontend can render them in two
  // sections.
  const unresolved = (await q`
    SELECT id, source, source_ref, location_id, person_id, deposit_kind_id, amount,
           attempts, last_attempt_at, last_error, created_at, resolved_at,
           resolved_deposit_id, notes
    FROM bmi_deposit_failures
    WHERE resolved_at IS NULL
    ORDER BY created_at DESC
    LIMIT 200
  `) as Array<Record<string, unknown>>;

  let resolved: Array<Record<string, unknown>> = [];
  if (include === "all") {
    resolved = (await q`
      SELECT id, source, source_ref, location_id, person_id, deposit_kind_id, amount,
             attempts, last_attempt_at, last_error, created_at, resolved_at,
             resolved_deposit_id, notes
      FROM bmi_deposit_failures
      WHERE resolved_at IS NOT NULL AND resolved_at > NOW() - INTERVAL '7 days'
      ORDER BY resolved_at DESC
      LIMIT 100
    `) as Array<Record<string, unknown>>;
  }

  const summary = await summarizeFailures();

  return NextResponse.json({
    unresolved: unresolved.map(toClient),
    resolved: resolved.map(toClient),
    summary,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

function toClient(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(r.id),
    source: String(r.source),
    sourceRef: String(r.source_ref),
    locationId: String(r.location_id),
    personId: String(r.person_id),
    depositKindId: String(r.deposit_kind_id),
    amount: Number(r.amount),
    attempts: Number(r.attempts) || 0,
    lastAttemptAt: r.last_attempt_at ? String(r.last_attempt_at) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
    resolvedDepositId: r.resolved_deposit_id ? String(r.resolved_deposit_id) : null,
    notes: r.notes ? String(r.notes) : null,
  };
}
