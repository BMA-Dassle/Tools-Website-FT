import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { recordRetryAttempt } from "@/lib/bmi-deposit-retry";

/**
 * Admin: retry a single deposit-failure row on demand.
 *
 *   POST /api/admin/deposit-failures/retry?token=...
 *   Body: { id: number }
 *
 * Useful when staff sees a row they want to push through immediately
 * instead of waiting for the next 5-min sweep. Same code path as the
 * sweep cron (calls /api/pandora/deposit, marks resolved on success).
 */

const CACHE_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";
const LEGACY_TOKEN = process.env.ADMIN_ETICKETS_TOKEN || "";
const SITE_BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const PANDORA_INTERNAL_KEY = process.env.SWAGGER_ADMIN_KEY || "";

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

  let body: { id?: unknown };
  try {
    body = (await req.json()) as { id?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  // Re-load the row so we don't have to trust the client's body
  // beyond the id. Also confirms the row still exists + is
  // unresolved before burning a Pandora call.
  const q = sql();
  const rows = (await q`
    SELECT id, source, source_ref, location_id, person_id, deposit_kind_id, amount, resolved_at
    FROM bmi_deposit_failures
    WHERE id = ${id}
  `) as Array<{
    id: number;
    source: string;
    source_ref: string;
    location_id: string;
    person_id: string;
    deposit_kind_id: string;
    amount: number;
    resolved_at: string | null;
  }>;
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }
  if (row.resolved_at) {
    return NextResponse.json({ ok: true, alreadyResolved: true });
  }

  if (!PANDORA_INTERNAL_KEY) {
    return NextResponse.json({ error: "SWAGGER_ADMIN_KEY not set" }, { status: 500 });
  }

  // Same call as the sweep cron — go through our /api/pandora/deposit
  // proxy so the audit log + trust gate apply.
  let depositId: string | undefined;
  let upstreamError: string | undefined;
  try {
    const res = await fetch(`${SITE_BASE}/api/pandora/deposit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pandora-internal": PANDORA_INTERNAL_KEY,
        "x-pandora-caller": "admin/deposit-failures/retry",
      },
      body: JSON.stringify({
        locationId: row.location_id,
        personId: row.person_id,
        depositKindId: row.deposit_kind_id,
        amount: row.amount,
      }),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (res.ok && typeof parsed === "object" && parsed && "data" in parsed) {
      const d = (parsed as Record<string, unknown>).data;
      if (typeof d === "object" && d && "depositID" in d) {
        depositId = String((d as Record<string, unknown>).depositID);
      } else if (typeof d === "object" && d && "data" in d) {
        const inner = (d as Record<string, unknown>).data;
        if (typeof inner === "object" && inner && "depositID" in inner) {
          depositId = String((inner as Record<string, unknown>).depositID);
        }
      }
    } else if (!res.ok) {
      upstreamError = typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as Record<string, unknown>).error)
        : `HTTP ${res.status}`;
    }
  } catch (err) {
    upstreamError = err instanceof Error ? err.message : "fetch failed";
  }

  if (depositId) {
    await recordRetryAttempt({ id: row.id, success: true, resolvedDepositId: depositId });
    return NextResponse.json({ ok: true, depositId });
  } else {
    await recordRetryAttempt({ id: row.id, success: false, error: upstreamError });
    return NextResponse.json({ ok: false, error: upstreamError ?? "unknown" }, { status: 502 });
  }
}
