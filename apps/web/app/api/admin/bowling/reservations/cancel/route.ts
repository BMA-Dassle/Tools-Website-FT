import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getBowlingReservation, updateBowlingReservationCancelled } from "@/lib/bowling-db";
import { deleteReservation } from "@/lib/qamf-bowling";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";
import { cancelBmiAttractions } from "@/lib/bmi-attraction-cancel";

const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

/**
 * POST /api/admin/bowling/reservations/cancel?token=...
 *
 * Admin cancellation — same logic as the customer cancel route but
 * WITHOUT the 1-hour cutoff. Admins can cancel at any time.
 *
 * Body: { neonId: number }
 * Auth: ADMIN_CAMERA_TOKEN query param.
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { neonId } = body as { neonId: number };

  if (!neonId) {
    return NextResponse.json({ error: "neonId required" }, { status: 400 });
  }

  const reservation = await getBowlingReservation(neonId);
  if (!reservation) {
    return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
  }

  if (reservation.status === "cancelled") {
    return NextResponse.json({ error: "Already cancelled" }, { status: 409 });
  }

  // ── 1. Cancel in QAMF (best-effort) ──────────────────────────────
  const qamfCenterId = CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
  if (qamfCenterId && reservation.qamfReservationId) {
    try {
      await deleteReservation(qamfCenterId, reservation.qamfReservationId);
    } catch (err) {
      console.warn(
        `[admin/bowling/cancel] QAMF delete non-fatal neonId=${neonId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── 2. Square refund (only if deposit was charged) ────────────────
  let squareRefundId: string | undefined;
  let refundCents = 0;

  if (reservation.squareDepositPaymentId && reservation.squareGiftCardId) {
    try {
      const result = await processSquareBowlingRefund({
        depositPaymentId: reservation.squareDepositPaymentId,
        giftCardId: reservation.squareGiftCardId,
        dayofOrderId: reservation.squareDayofOrderId,
        locationId: reservation.centerCode,
        idempotencyKey: `admin-cancel-${neonId}-${randomUUID()}`,
      });
      squareRefundId = result.refundId;
      refundCents = result.refundedCents;
      console.log(`[admin/bowling/cancel] refunded ${refundCents}c neonId=${neonId}`);
    } catch (err) {
      console.error(
        `[admin/bowling/cancel] Square refund failed neonId=${neonId}:`,
        err instanceof Error ? err.message : err,
      );
      return NextResponse.json(
        { error: "Refund failed — try again or issue manual refund in Square." },
        { status: 502 },
      );
    }
  }

  // ── 2b. Cancel BMI attraction bookings (best-effort) ──────────────
  if (reservation.attractionBookings?.length) {
    await cancelBmiAttractions(reservation.centerCode, reservation.attractionBookings);
  }

  // ── 3. Mark cancelled in Neon ─────────────────────────────────────
  await updateBowlingReservationCancelled(neonId, { squareRefundId, refundCents });
  console.log(`[admin/bowling/cancel] neonId=${neonId} cancelled refundCents=${refundCents}`);

  return NextResponse.json({ ok: true, refundCents });
}
