import { NextRequest, NextResponse } from "next/server";
import { patchReservation } from "@/lib/qamf-bowling";
import { getBowlingReservation, updateReservationReschedule } from "@/lib/bowling-db";
import { sql } from "@/lib/db";
import { cancelBmiAttractions } from "@/lib/bmi-attraction-cancel";

/**
 * PATCH /api/bowling/v2/reservations/[id]/reschedule
 *
 * Moves an existing reservation to a new date/time within the same web offer.
 * Works for all product kinds (KBF + open bowling).
 *
 * Flow:
 *  1. Load existing Neon record
 *  2. PATCH existing QAMF reservation with new BookedAt
 *  3. If old attractions exist, cancel them on BMI
 *  4. Update Neon: booked_at, clear attraction_bookings + lane-open fields
 *  5. Resend confirmation email + SMS
 *
 * Payment is not touched — Square deposit/day-of orders are unchanged.
 * A reschedule is a time-only change within the same web offer; price stays the same.
 *
 * Body:
 *   bookedAt    — ISO 8601 with ET offset from the new availability slot
 *   webOfferId  — QAMF web offer ID (from the slot)
 *   optionId?   — QAMF option ID (game/time/unlimited)
 *   optionType? — "Game" | "Time" | "Unlimited" (default "Game")
 */

const SQUARE_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await ctx.params;
  const neonId = parseInt(idStr, 10);
  if (isNaN(neonId) || neonId < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: {
    bookedAt: string;
    webOfferId: number;
    optionId?: number;
    optionType?: "Game" | "Time" | "Unlimited";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { bookedAt, webOfferId } = body;
  if (!bookedAt || !webOfferId) {
    return NextResponse.json(
      { error: "bookedAt and webOfferId are required" },
      { status: 400 },
    );
  }

  // ── Load existing Neon record ────────────────────────────────────
  const existing = await getBowlingReservation(neonId);
  if (!existing) {
    return NextResponse.json({ error: "reservation not found" }, { status: 404 });
  }
  if (existing.status === "cancelled") {
    return NextResponse.json(
      { error: "cannot reschedule a cancelled reservation" },
      { status: 400 },
    );
  }
  if (existing.status === "completed") {
    return NextResponse.json(
      { error: "cannot reschedule a completed reservation" },
      { status: 400 },
    );
  }

  const qamfCenterId = SQUARE_CODE_TO_QAMF[existing.centerCode];
  if (!qamfCenterId) {
    return NextResponse.json(
      { error: `unknown centerCode: ${existing.centerCode}` },
      { status: 400 },
    );
  }

  // ── PATCH existing QAMF reservation with new time ────────────────
  if (existing.qamfReservationId) {
    try {
      await patchReservation(qamfCenterId, existing.qamfReservationId, {
        BookedAt: bookedAt,
      });
      console.log(
        `[bowling/v2/reschedule] QAMF PATCH ok neonId=${neonId} qamfId=${existing.qamfReservationId} → ${bookedAt}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "QAMF error";
      console.error("[bowling/v2/reschedule] QAMF PATCH failed:", msg);
      return NextResponse.json(
        { error: `Reschedule failed: ${msg}` },
        { status: 502 },
      );
    }
  }

  // ── Cancel old BMI attraction bookings (best-effort) ─────────────
  if (existing.attractionBookings?.length) {
    await cancelBmiAttractions(existing.centerCode, existing.attractionBookings);
  }

  // ── Update Neon ──────────────────────────────────────────────────
  await updateReservationReschedule(neonId, bookedAt, existing.qamfReservationId ?? "");

  // Reset status + clear lane-open fields
  try {
    const q = sql();
    await q`
      UPDATE bowling_reservations
      SET status = 'confirmed',
          dayof_order_sent_at = NULL,
          dayof_order_lane = NULL,
          dayof_payment_id = NULL,
          dayof_order_error = NULL
      WHERE id = ${neonId}
        AND status NOT IN ('cancelled')
    `;
  } catch (err) {
    console.error("[bowling/v2/reschedule] status reset failed:", err);
  }

  // ── Resend confirmation (fire-and-forget) ────────────────────────
  try {
    const origin = req.nextUrl.origin;
    void fetch(`${origin}/api/notifications/bowling-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        neonId,
        smsOptIn: true,
        channel: "both",
        forceResend: true,
      }),
    }).catch(() => {});
  } catch { /* non-fatal */ }

  return NextResponse.json({
    id: neonId,
    bookedAt,
    qamfReservationId: existing.qamfReservationId,
  });
}
