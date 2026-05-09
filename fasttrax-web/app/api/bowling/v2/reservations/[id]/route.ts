import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getBowlingReservation, updateBowlingReservationCancelled } from "@/lib/bowling-db";
import { deleteReservation } from "@/lib/qamf-bowling";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";

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
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
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

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

/** Cancellations must be requested at least this many ms before the booking. */
const CANCEL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const reservation = await getBowlingReservation(id);
  if (!reservation) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (reservation.status === "cancelled") {
    return NextResponse.json({
      message: "already cancelled",
      refundCents: reservation.refundCents ?? 0,
    });
  }

  // ── 1-hour cancellation window ──────────────────────────────────
  const bookedAtMs  = new Date(reservation.bookedAt).getTime();
  const nowMs       = Date.now();
  const msUntilGame = bookedAtMs - nowMs;

  if (msUntilGame < CANCEL_WINDOW_MS) {
    return NextResponse.json(
      { error: "too_late", message: "Cancellations must be made at least 1 hour before your start time." },
      { status: 409 },
    );
  }

  // ── Delete QAMF reservation (best-effort) ───────────────────────
  if (reservation.qamfReservationId) {
    const qamfCenterId = CENTER_CODE_TO_QAMF[reservation.centerCode];
    if (qamfCenterId) {
      try {
        await deleteReservation(qamfCenterId, reservation.qamfReservationId);
      } catch {
        // Non-fatal — QAMF reservation may have already expired or been played
      }
    }
  }

  // ── Square refund + day-of order cancellation ───────────────────
  let squareRefundId: string | undefined;
  let refundCents = 0;

  if (reservation.squareDepositPaymentId && reservation.squareGiftCardId) {
    try {
      const result = await processSquareBowlingRefund({
        depositPaymentId: reservation.squareDepositPaymentId,
        giftCardId:       reservation.squareGiftCardId,
        dayofOrderId:     reservation.squareDayofOrderId,
        locationId:       reservation.centerCode,
        idempotencyKey:   randomUUID(),
      });
      squareRefundId = result.refundId;
      refundCents    = result.refundedCents;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Refund request failed";
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  }

  // ── Persist cancellation to Neon ────────────────────────────────
  await updateBowlingReservationCancelled(id, { squareRefundId, refundCents });

  return NextResponse.json({
    message: "cancelled",
    refundCents,
    squareRefundId,
  });
}
