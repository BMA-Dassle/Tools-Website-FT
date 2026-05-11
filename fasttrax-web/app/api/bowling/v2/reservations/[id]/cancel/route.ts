import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  getBowlingReservation,
  updateBowlingReservationCancelled,
} from "@/lib/bowling-db";
import { deleteReservation } from "@/lib/qamf-bowling";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";

/**
 * POST /api/bowling/v2/reservations/[id]/cancel
 *
 * Customer-facing cancellation endpoint.
 * 1. Fetches reservation from Neon
 * 2. Guards against double-cancel
 * 3. Cancels the QAMF reservation (best-effort)
 * 4. Refunds deposit via Square (if applicable)
 * 5. Marks reservation cancelled in Neon
 *
 * Body: {} (no required fields; neonId comes from the URL param)
 * Returns: { ok, refundCents }
 */

const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const neonId = parseInt(id, 10);
  if (!neonId || isNaN(neonId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const reservation = await getBowlingReservation(neonId);
  if (!reservation) {
    return NextResponse.json({ error: "reservation not found" }, { status: 404 });
  }

  if (reservation.status === "cancelled") {
    return NextResponse.json({ error: "already cancelled" }, { status: 409 });
  }

  // ── Within-1-hour cutoff ──────────────────────────────────────────
  // Cancellations less than 1 hour before the reservation start must be
  // handled by the center — automated refunds at this point require staff
  // coordination. Return a distinct error code so the UI can show the
  // "please call" message rather than a generic error.
  const msUntilStart = new Date(reservation.bookedAt).getTime() - Date.now();
  if (msUntilStart < 60 * 60 * 1000) {
    return NextResponse.json(
      { error: "within_1_hour" },
      { status: 409 },
    );
  }

  // ── 1. Cancel in QAMF (best-effort) ──────────────────────────────
  const qamfCenterId = CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
  if (qamfCenterId && reservation.qamfReservationId) {
    try {
      await deleteReservation(qamfCenterId, reservation.qamfReservationId);
      console.log(
        `[bowling/cancel] QAMF delete ok neonId=${neonId}` +
        ` qamfId=${reservation.qamfReservationId}`,
      );
    } catch (err) {
      // Non-fatal — reservation may already be gone; Neon + Square still proceed
      console.warn(
        `[bowling/cancel] QAMF delete non-fatal neonId=${neonId}:`,
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
        giftCardId:       reservation.squareGiftCardId,
        dayofOrderId:     reservation.squareDayofOrderId,
        locationId:       reservation.centerCode,
        idempotencyKey:   `cancel-${neonId}-${randomUUID()}`,
      });
      squareRefundId = result.refundId;
      refundCents    = result.refundedCents;
      console.log(
        `[bowling/cancel] refunded ${refundCents}¢ neonId=${neonId}` +
        ` refundId=${squareRefundId}`,
      );
    } catch (err) {
      console.error(
        `[bowling/cancel] Square refund failed neonId=${neonId}:`,
        err instanceof Error ? err.message : err,
      );
      // Return error — don't mark cancelled if we couldn't refund.
      // Staff can retry or issue a manual refund.
      return NextResponse.json(
        { error: "Refund failed — contact the center for assistance." },
        { status: 502 },
      );
    }
  }

  // ── 2b. Delete loyalty reward → return points to customer ─────────
  if (reservation.squareLoyaltyRewardId) {
    try {
      const SQUARE_BASE = "https://connect.squareup.com/v2";
      const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
      const delRes = await fetch(`${SQUARE_BASE}/loyalty/rewards/${reservation.squareLoyaltyRewardId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${SQUARE_TOKEN}`,
          "Square-Version": "2024-12-18",
          "Content-Type": "application/json",
        },
      });
      if (delRes.ok) {
        console.log(
          `[bowling/cancel] loyalty reward deleted neonId=${neonId}` +
          ` rewardId=${reservation.squareLoyaltyRewardId} (points returned)`,
        );
      } else {
        // REDEEMED rewards can't be deleted — points are already used. Non-fatal.
        console.warn(
          `[bowling/cancel] loyalty reward delete failed neonId=${neonId}: ${delRes.status}`,
        );
      }
    } catch (err) {
      console.warn(
        `[bowling/cancel] loyalty reward delete non-fatal neonId=${neonId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── 3. Mark cancelled in Neon ─────────────────────────────────────
  await updateBowlingReservationCancelled(neonId, { squareRefundId, refundCents });
  console.log(`[bowling/cancel] neonId=${neonId} marked cancelled refundCents=${refundCents}`);

  return NextResponse.json({ ok: true, refundCents });
}
