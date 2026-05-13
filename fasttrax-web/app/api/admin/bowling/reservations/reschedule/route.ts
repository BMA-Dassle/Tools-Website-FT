import { NextRequest, NextResponse } from "next/server";
import {
  createReservation,
  deleteReservation,
  patchReservation,
  setReservationStatus,
} from "@/lib/qamf-bowling";
import {
  buildQamfMemo,
  getBowlingReservation,
  updateReservationReschedule,
} from "@/lib/bowling-db";
import { sql } from "@/lib/db";
import { cancelBmiAttractions } from "@/lib/bmi-attraction-cancel";

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

/**
 * POST /api/admin/bowling/reservations/reschedule?token=…
 *
 * Admin-only: reschedule a bowling reservation to a new time within the
 * same web offer. Works for all product kinds (KBF + open bowling).
 *
 * Flow:
 *   1. Load Neon reservation
 *   2. Delete old QAMF reservation (best-effort — may have expired)
 *   3. Create new QAMF reservation at the new time
 *   4. Confirm the new QAMF reservation — MUST succeed or we fail
 *   5. Update Neon (booked_at + qamf_reservation_id + status → confirmed)
 *   6. Resend confirmation email + SMS (fire-and-forget)
 *
 * Payment (Square deposit / day-of order) is NOT touched — the price
 * doesn't change for a time-only reschedule within the same web offer.
 *
 * Body: { neonId, bookedAt, webOfferId, optionId?, optionType? }
 */
export async function POST(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── Parse body ─────────────────────────────────────────────────────
  let body: {
    neonId: number;
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

  const { neonId, bookedAt, webOfferId, optionId, optionType = "Game" } = body;
  if (!neonId || !bookedAt || !webOfferId) {
    return NextResponse.json(
      { error: "neonId, bookedAt, and webOfferId are required" },
      { status: 400 },
    );
  }

  // ── Load existing reservation ──────────────────────────────────────
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

  const qamfCenterId = CENTER_CODE_TO_QAMF[existing.centerCode];
  if (!qamfCenterId) {
    return NextResponse.json(
      { error: `unknown center: ${existing.centerCode}` },
      { status: 400 },
    );
  }

  // ── Cancel BMI attraction bookings (best-effort) ──────────────────
  if (existing.attractionBookings?.length) {
    await cancelBmiAttractions(existing.centerCode, existing.attractionBookings);
  }

  // ── Unlink old QAMF ID from Neon BEFORE deleting ───────────────────
  // QAMF fires a reservation.deleted webhook when we delete below.
  // The webhook handler looks up Neon by qamf_reservation_id — if the
  // old ID is still on the row it will cancel + refund the booking.
  // Clearing the ID first makes the webhook find no matching row → skip.
  if (existing.qamfReservationId) {
    try {
      const q = sql();
      await q`
        UPDATE bowling_reservations
        SET qamf_reservation_id = NULL
        WHERE id = ${neonId}
      `;
    } catch (err) {
      console.error("[admin/reschedule] failed to clear old qamfId:", err);
    }

    // ── Delete old QAMF reservation (best-effort) ───────────────────
    // Revert to Temporary first — QAMF may ignore DELETE on Confirmed
    // reservations. Temporary releases the lane assignment.
    try {
      await setReservationStatus(qamfCenterId, existing.qamfReservationId, "Temporary");
    } catch (err) {
      console.warn(
        `[admin/reschedule] neonId=${neonId} revert old QAMF ${existing.qamfReservationId} to Temporary failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    try {
      await deleteReservation(qamfCenterId, existing.qamfReservationId);
      console.log(`[admin/reschedule] neonId=${neonId} deleted old QAMF ${existing.qamfReservationId}`);
    } catch (err) {
      // Non-fatal: hold may have expired or been removed already.
      console.warn(
        `[admin/reschedule] neonId=${neonId} delete old QAMF ${existing.qamfReservationId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Build QAMF WebOffer.Options ────────────────────────────────────
  const qamfOptions: {
    Game?: { Id: number }[];
    Time?: { Id: number }[];
    Unlimited?: { Id: number }[];
  } = {};
  if (optionId) {
    if (optionType === "Time") qamfOptions.Time = [{ Id: optionId }];
    else if (optionType === "Unlimited") qamfOptions.Unlimited = [{ Id: optionId }];
    else qamfOptions.Game = [{ Id: optionId }];
  }

  // ── Create new QAMF reservation ────────────────────────────────────
  let newQamfId: string;
  try {
    const created = await createReservation(qamfCenterId, {
      BookedAt: bookedAt,
      Title: `${existing.guestName ?? "Guest"} (${existing.playerCount ?? 1}p)`,
      Notes: existing.notes,
      Customer: {
        Guest: {
          Name: existing.guestName ?? "Guest",
          PhoneNumber: existing.guestPhone ?? "",
          Email: existing.guestEmail ?? "",
        },
      },
      WebOffer: {
        Id: webOfferId,
        Options: qamfOptions,
        Services: ["BookForLater"],
      },
      TotalPlayers: existing.playerCount ?? 1,
    });
    newQamfId = created.Id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF error";
    console.error("[admin/reschedule] createReservation failed:", msg);
    return NextResponse.json(
      { error: `QAMF failed to create new reservation: ${msg}` },
      { status: 502 },
    );
  }

  // ── Confirm — MUST succeed or we fail the whole operation ──────────
  try {
    await setReservationStatus(qamfCenterId, newQamfId, "Confirmed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF error";
    console.error("[admin/reschedule] setReservationStatus failed:", msg);
    // Try to clean up the orphaned temporary reservation
    try {
      await deleteReservation(qamfCenterId, newQamfId);
    } catch { /* best effort */ }
    return NextResponse.json(
      { error: `QAMF failed to confirm new reservation: ${msg}` },
      { status: 502 },
    );
  }

  // ── Update Neon ────────────────────────────────────────────────────
  await updateReservationReschedule(neonId, bookedAt, newQamfId);

  // Also reset status to "confirmed" (in case it was arrived / pending)
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
        -- no status guard: reschedule must override even if webhook raced
    `;
  } catch (err) {
    console.error("[admin/reschedule] status reset failed:", err);
    // Non-fatal — the core reschedule (QAMF + booked_at) succeeded
  }

  // ── Restore QAMF memo (shoe status, line items, deposit) ───────────
  try {
    const memo = await buildQamfMemo(neonId);
    if (memo) {
      await patchReservation(qamfCenterId, newQamfId, { Notes: memo });
    }
  } catch (err) {
    console.warn("[admin/reschedule] memo patch failed:", err instanceof Error ? err.message : err);
  }

  // ── Resend confirmation (fire-and-forget) ──────────────────────────
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
    success: true,
    bookedAt,
    qamfReservationId: newQamfId,
  });
}
