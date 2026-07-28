import { NextRequest, NextResponse } from "next/server";
import { buildEditPlan } from "~/features/reservation-edit/plan";
import { isRefundOnlyPlan } from "~/features/reservation-edit/guards";
import { EditGuardError, type EditSettlement, type EditSpec } from "~/features/reservation-edit";

// Live Square reads (order snapshots + orders/calculate per leg) can stack up
// for combo groups.
export const maxDuration = 60;

/** Guard codes that mean "state moved / not editable" → 409; the rest → 400. */
const CONFLICT_CODES = new Set([
  "cancelled",
  "phase_conflict",
  "combo_phase_split",
  "leg_phase_split",
  "lane_change_mid_session",
  "mid_session_unsupported",
  "edit_in_progress",
  "cancel_in_progress",
  "plan_stale",
  "post_complete_ack_required",
  "refund_not_enabled",
  "full_refund_use_cancel",
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
 *
 * Execution gates (dry-run is always allowed, so the preview is never hidden):
 *   - refund-only plans  → RESERVATION_EDIT_V2_MID_DECREASE / _POST by phase
 *   - everything else    → RESERVATION_EDIT_V2 (master), flag-off → 501
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
    dayofRefundReason?: unknown;
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
    // The master switch unlocks the whole engine. A plan that ONLY hands money
    // back for an already-paid day-of order is exempt: it rides its own phase
    // flag (RESERVATION_EDIT_V2_MID_DECREASE / _POST, enforced in the service).
    // Without that exemption, giving a guest their money back would require
    // enabling PRE-phase editing too — whose QAMF player sync is blocked by a
    // vendor bug — so the two are deliberately decoupled.
    if (process.env.RESERVATION_EDIT_V2 !== "true" && !isRefundOnlyPlan(plan)) {
      return NextResponse.json(
        {
          error: "not_enabled",
          detail:
            "Changing a reservation is not enabled in this environment " +
            "(RESERVATION_EDIT_V2) — only refunds are.",
        },
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
      // Staff-entered, recorded on the Square refund for the day-of leg. The
      // executor rejects a missing/reserved value before any money moves.
      dayofRefundReason:
        typeof body.dayofRefundReason === "string" ? body.dayofRefundReason : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof EditGuardError) {
      const status = err.code === "not_found" ? 404 : CONFLICT_CODES.has(err.code) ? 409 : 400;
      return NextResponse.json(
        {
          error: err.code,
          detail: err.message,
          // no_changes ships the `current` block so the modal can hydrate its
          // form on open (see EditGuardError.data).
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
        { status },
      );
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/reservations/edit] neonId=${neonId} failed:`, msg);
    return NextResponse.json({ error: "edit_failed", detail: msg }, { status: 502 });
  }
}
