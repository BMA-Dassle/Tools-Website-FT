import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation, updateBowlingReservationStatus } from "@/lib/bowling-db";
import { deleteReservation } from "@/lib/qamf-bowling";

/**
 * GET /api/bowling/v2/reservations/[id]
 *
 * Returns a single bowling reservation by Neon row ID, including line items.
 * Used by the confirmation pages to display booking details.
 *
 * DELETE /api/bowling/v2/reservations/[id]
 *
 * Cancels an existing KBF reservation:
 *   1. Deletes the QAMF reservation (best-effort — may have expired)
 *   2. Sets Neon status = 'cancelled'
 *
 * Note: Square deposit refunds must be handled manually for paid bookings.
 * The response includes `depositCents` so the caller can display a refund notice.
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

const SQUARE_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

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
    return NextResponse.json({ message: "already cancelled", depositCents: 0 });
  }

  // ── Delete QAMF reservation (best-effort) ───────────────────────
  if (reservation.qamfReservationId) {
    const qamfId = SQUARE_CODE_TO_QAMF[reservation.centerCode];
    if (qamfId) {
      try {
        await deleteReservation(qamfId, reservation.qamfReservationId);
      } catch {
        // Non-fatal — QAMF reservation may have already expired
      }
    }
  }

  // ── Mark cancelled in Neon ──────────────────────────────────────
  await updateBowlingReservationStatus(id, "cancelled");

  return NextResponse.json({
    message: "cancelled",
    depositCents: reservation.depositCents,
    hasPaidDeposit: reservation.depositCents > 0,
  });
}
