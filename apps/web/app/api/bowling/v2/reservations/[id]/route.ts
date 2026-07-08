import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation } from "@/lib/bowling-db";
import { CancelGuardError, cancelReservationCascade } from "~/features/cancellation";

// Cancel teardown + BMI state verification (Pandora writes can take ~25s to
// become visible) can exceed the default function window.
export const maxDuration = 60;

/**
 * GET /api/bowling/v2/reservations/[id]
 *
 * Returns a single bowling reservation by Neon row ID, including line items.
 * Used by the confirmation pages to display booking details.
 *
 * DELETE /api/bowling/v2/reservations/[id]
 *
 * Cancels a bowling reservation with full refund (up to 1 hour before start):
 *   1. Validates the 1-hour cancellation window
 *   2. Deletes the QAMF reservation (best-effort — may have expired)
 *   3. If a deposit was paid: refunds via Square + cancels day-of order
 *   4. Updates Neon: status=cancelled, cancelled_at, square_refund_id, refund_cents
 *
 * Returns 409 if the booking is within 1 hour of start.
 *
 * Params:
 *   id — bowling_reservations.id (integer)
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const reservation = await getBowlingReservation(id);
    if (!reservation) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(reservation);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  // Delegates to the cancellation cascade (kills the old drift: this route
  // previously skipped the loyalty-reward delete and BMI add-on cancels).
  // Response contract preserved for legacy callers. Owner policy 2026-07-03:
  // customer card refunds are staff-only — this legacy refund route now 403s
  // via the cascade guard with the call-us message (stale surfaces only).
  try {
    const result = await cancelReservationCascade({
      neonId: id,
      outcome: "refund",
      actor: "customer",
      dryRun: false,
    });
    if (result.alreadyCancelled) {
      return NextResponse.json({
        message: "already cancelled",
        refundCents: result.refundCents ?? 0,
      });
    }
    return NextResponse.json({
      message: "cancelled",
      refundCents: result.refundCents ?? 0,
      squareRefundId: result.refundIds?.[0],
    });
  } catch (err) {
    if (err instanceof CancelGuardError) {
      if (err.code === "within_1_hour") {
        return NextResponse.json(
          {
            error: "too_late",
            message: "Cancellations must be made at least 1 hour before your start time.",
          },
          { status: 409 },
        );
      }
      if (err.code === "not_found") {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    const msg = err instanceof Error ? err.message : "Refund request failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
