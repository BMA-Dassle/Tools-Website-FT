import { NextRequest, NextResponse } from "next/server";
import { buildEditPlan } from "~/features/reservation-edit/plan";
import { EditGuardError, type EditSettlement, type EditSpec } from "~/features/reservation-edit";

// Live Square reads (order snapshots + orders/calculate per leg) can stack up
// for combo groups.
export const maxDuration = 60;

/** Guard codes that mean "state moved / not editable" → 409; the rest → 400. */
const CONFLICT_CODES = new Set([
  "cancelled",
  "phase_conflict",
  "combo_phase_split",
  "lane_change_mid_session",
  "mid_session_unsupported",
  "edit_in_progress",
  "cancel_in_progress",
  "plan_stale",
  "post_complete_ack_required",
]);

/**
 * POST /api/admin/reservations/edit?token=...
 *
 * Staff reservation editing — dry-run + execute for every reservation kind
 * (bowling/KBF/race/attraction + VIP combos). The modal calls dryRun on open
 * and on every form change; the response IS the preview (old→new lines, the
 * authoritative Square-calculated diff, ordered steps, warnings). Execution
 * requires the dry-run's planHash (displayed == executed).
 *
 * Body: {
 *   neonId: number,
 *   spec: EditSpec,                       // desired END STATE (see types.ts)
 *   settlement?: "card_refund" | "store_credit",   // decreases
 *   paymentSource?: { kind: "card_on_file", cardId } | { kind: "payment_link" } | { kind: "none" },
 *   dryRun?: boolean,
 *   planHash?: string,                    // required when dryRun is false
 *   notifyGuest?: boolean,
 *   managerOverride?: boolean,            // post-complete acknowledgment
 * }
 *
 * Auth: ADMIN_CAMERA_TOKEN query param (portal convention).
 * Execution is additionally gated by RESERVATION_EDIT_V2 (flag-off → 501).
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    neonId?: unknown;
    spec?: unknown;
    settlement?: unknown;
    paymentSource?: unknown;
    dryRun?: unknown;
    planHash?: unknown;
    notifyGuest?: unknown;
    managerOverride?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const neonId = typeof body.neonId === "number" ? body.neonId : parseInt(String(body.neonId), 10);
  if (!neonId || Number.isNaN(neonId)) {
    return NextResponse.json({ error: "neonId required" }, { status: 400 });
  }
  const spec = (body.spec ?? {}) as EditSpec;
  const settlement: EditSettlement | undefined =
    body.settlement === "store_credit"
      ? "store_credit"
      : body.settlement === "card_refund"
        ? "card_refund"
        : undefined;
  const paymentSource = body.paymentSource as
    | { kind: "card_on_file"; cardId: string }
    | { kind: "payment_link" }
    | { kind: "none" }
    | undefined;
  const managerOverride = body.managerOverride === true;

  try {
    const plan = await buildEditPlan({ neonId, spec, settlement, paymentSource, managerOverride });

    if (body.dryRun !== false) {
      return NextResponse.json({ plan });
    }

    // ── Execute ────────────────────────────────────────────────────────
    if (process.env.RESERVATION_EDIT_V2 !== "true") {
      return NextResponse.json(
        { error: "not_enabled", detail: "RESERVATION_EDIT_V2 is off — dry-run only" },
        { status: 501 },
      );
    }
    if (typeof body.planHash !== "string" || body.planHash.length === 0) {
      return NextResponse.json({ error: "plan_hash_required" }, { status: 400 });
    }
    if (body.planHash !== plan.planHash) {
      return NextResponse.json(
        { error: "plan_stale", detail: "the reservation changed since the preview — re-check" },
        { status: 409 },
      );
    }

    const { executeEditCascade } = await import("~/features/reservation-edit/service");
    const result = await executeEditCascade({
      plan,
      settlement,
      paymentSource,
      notifyGuest: body.notifyGuest !== false,
      actor: "admin",
      origin: req.nextUrl.origin,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof EditGuardError) {
      const status = err.code === "not_found" ? 404 : CONFLICT_CODES.has(err.code) ? 409 : 400;
      return NextResponse.json({ error: err.code, detail: err.message }, { status });
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/reservations/edit] neonId=${neonId} failed:`, msg);
    return NextResponse.json({ error: "edit_failed", detail: msg }, { status: 502 });
  }
}
