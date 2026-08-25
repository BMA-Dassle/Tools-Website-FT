import { NextRequest, NextResponse } from "next/server";
import { buildEditPlan } from "~/features/reservation-edit/plan";
import {
  editFlagEnabled,
  isPreDecreaseOnlyPlan,
  isRefundOnlyPlan,
  PRE_DECREASE_FLAG,
} from "~/features/reservation-edit/guards";
import {
  EditExecutionError,
  EditGuardError,
  type EditSettlement,
  type EditSpec,
} from "~/features/reservation-edit";
import { recordAdminAction } from "~/features/reservations-admin/audit";

// Live Square reads (order snapshots + orders/calculate per leg) can stack up
// for combo groups.
export const maxDuration = 60;

/**
 * Guard codes that mean "state moved / not editable / not this way" → 409 so
 * the modal renders a BLOCKED screen (Close only). Everything else → 400,
 * which the modal treats as an operator-correctable error. Capacity and
 * config refusals used to fall through as 400 and were offered "Retry" +
 * "Send payment link".
 */
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
  "ack_required",
  "refund_not_enabled",
  "edit_not_enabled",
  "full_refund_use_cancel",
  "conqueror_origin",
  "dayof_payment_unresolved",
  "heat_capacity",
  "qamf_availability",
  "bmi_line_unavailable",
  "unsupported_kind",
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
 * Execution kill switches (dry-run is always allowed, so the preview is never
 * hidden). All default ON — only an explicit `=false` stops execution:
 *   - refund-only plans  → RESERVATION_EDIT_V2_MID_DECREASE / _POST by phase
 *   - everything else    → RESERVATION_EDIT_V2 (master), killed → 501
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
    acknowledgedCodes?: unknown;
    acknowledgedBy?: unknown;
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
  const acknowledgedCodes = Array.isArray(body.acknowledgedCodes)
    ? body.acknowledgedCodes.filter((c): c is string => typeof c === "string")
    : undefined;
  const acknowledgedBy =
    typeof body.acknowledgedBy === "string" ? body.acknowledgedBy.trim().slice(0, 8) : undefined;
  const dryRun = body.dryRun !== false;

  try {
    const plan = await buildEditPlan({ neonId, spec, settlement, paymentSource, managerOverride });

    if (dryRun) {
      return NextResponse.json({ plan });
    }

    // ── Execute ────────────────────────────────────────────────────────
    // The master kill switch covers the whole engine and is ON unless someone
    // set it to "false". A plan that ONLY hands money back for an already-paid
    // day-of order is exempt: it rides its own phase switch
    // (RESERVATION_EDIT_V2_MID_DECREASE / _POST, enforced in the service), so
    // killing editing never strands a guest's refund.
    // A pre-payment REDUCTION is money-symmetric with a refund (value back to
    // the guest, an untendered order's lines corrected, nothing charged), so it
    // rides its own kill switch too. Checked first so its own switch wins in
    // BOTH directions: off here even when the master is on, on here even when
    // the master is off.
    const preDecrease = isPreDecreaseOnlyPlan(plan);
    if (preDecrease && !editFlagEnabled(PRE_DECREASE_FLAG)) {
      return NextResponse.json(
        {
          error: "not_enabled",
          detail:
            "Reducing a booking before check-in has been switched off in this " +
            `environment (${PRE_DECREASE_FLAG}=false).`,
        },
        { status: 501 },
      );
    }
    if (!editFlagEnabled("RESERVATION_EDIT_V2") && !isRefundOnlyPlan(plan) && !preDecrease) {
      return NextResponse.json(
        {
          error: "not_enabled",
          detail:
            "Reservation editing has been switched off in this environment " +
            "(RESERVATION_EDIT_V2=false) — only refunds and pre-check-in reductions are running.",
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
      // Owner rule 2026-08-24: every "Conqueror/BMI will NOT be updated"
      // warning is acknowledged (by code, with initials) before money moves;
      // the executor refuses ack_required otherwise and records who ticked what.
      acknowledgedCodes,
      acknowledgedBy,
      managerOverride,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof EditGuardError) {
      const status = err.code === "not_found" ? 404 : CONFLICT_CODES.has(err.code) ? 409 : 400;
      // Refusals used to leave no trace anywhere (guard 4xx were not logged and
      // the ledger records executions only), so nobody could tell how often
      // staff hit a wall or on which rows. The mount probe's no_changes is
      // the healthy answer and stays quiet.
      if (err.code !== "no_changes") {
        console.warn(
          `[admin/reservations/edit] neonId=${neonId} ${dryRun ? "dry-run" : "EXECUTE"} refused: ${err.code} — ${err.message}`,
        );
        if (!dryRun) {
          await recordAdminAction({
            reservationId: neonId,
            action: "edit",
            outcome: "failed",
            detail: { blocked: true, code: err.code, spec },
            error: err.message,
          });
        }
      }
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
    if (err instanceof EditExecutionError) {
      console.error(
        `[admin/reservations/edit] neonId=${neonId} ${err.editId} failed at ${err.failedStep ?? "?"}:`,
        err.message,
      );
      return NextResponse.json(
        {
          error: "edit_failed",
          detail: err.message,
          editId: err.editId,
          failedStep: err.failedStep ?? null,
          stepLog: err.stepLog,
        },
        { status: 502 },
      );
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/reservations/edit] neonId=${neonId} failed:`, msg);
    return NextResponse.json({ error: "edit_failed", detail: msg }, { status: 502 });
  }
}
