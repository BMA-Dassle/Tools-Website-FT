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
  getKbfRedeemedMembers,
  getReservationPlayersWithShoeAllowance,
  updateReservationReschedule,
} from "@/lib/bowling-db";
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
 *  2. Delete old QAMF reservation (best-effort — may have already expired)
 *  3. Create new QAMF reservation at the new time with identical guest/player data
 *  4. Confirm new QAMF reservation — MUST succeed or whole operation fails
 *  5. Update bowling_reservations: booked_at + qamf_reservation_id + status
 *  6. Resend confirmation email + SMS
 *  7. Return { id, bookedAt, qamfReservationId }
 *
 * Payment is not touched — Square deposit/day-of orders are unchanged.
 * A reschedule is a time-only change within the same web offer; price stays the same.
 *
 * Body:
 *   bookedAt    — ISO 8601 with ET offset from the new availability slot
 *   webOfferId  — QAMF web offer ID (from the slot)
 *   optionId?   — QAMF option ID (game/time/unlimited, from the slot)
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

  const { bookedAt, webOfferId, optionId, optionType = "Game" } = body;
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

  // ── KBF: per-day redemption check (exclude this reservation) ──────
  if (existing.productKind === "kbf") {
    const newDate = bookedAt.slice(0, 10);
    try {
      const { players: existingPlayers } = await getReservationPlayersWithShoeAllowance(neonId);
      const kbfPairs = existingPlayers
        .filter((p) => p.kbfPassId && p.kbfMemberSlot != null)
        .map((p) => ({ passId: p.kbfPassId!, slot: p.kbfMemberSlot! }));
      if (kbfPairs.length > 0) {
        const redeemed = await getKbfRedeemedMembers(newDate, kbfPairs, neonId);
        if (redeemed.length > 0) {
          const names = redeemed.map((r) => {
            const p = existingPlayers.find(
              (pl) => pl.kbfPassId === r.passId && pl.kbfMemberSlot === r.slot,
            );
            return p?.name ?? "a bowler";
          });
          return NextResponse.json(
            { error: `${names.join(", ")} already used their free games for ${newDate}.` },
            { status: 409 },
          );
        }
      }
    } catch (err) {
      console.error("[bowling/v2/reschedule] redemption check failed (non-fatal):", err);
    }
  }

  // ── Cancel BMI attraction bookings (best-effort) ──────────────────
  // Attractions are time-specific and cannot transfer to the new bowling
  // time slot. They're cleared from Neon in updateReservationReschedule().
  // The customer can re-add attractions after rescheduling.
  if (existing.attractionBookings?.length) {
    await cancelBmiAttractions(existing.centerCode, existing.attractionBookings);
  }

  // ── Unlink old QAMF ID from Neon BEFORE deleting ──────────────────
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
      console.error("[bowling/v2/reschedule] failed to clear old qamfId:", err);
    }

    // ── Delete old QAMF reservation (best-effort) ──────────────────
    // Revert to Temporary first — QAMF may ignore DELETE on Confirmed
    // reservations. Temporary releases the lane assignment.
    try {
      await setReservationStatus(qamfCenterId, existing.qamfReservationId, "Temporary");
    } catch (err) {
      console.warn(
        `[reschedule] neonId=${neonId} revert old QAMF ${existing.qamfReservationId} to Temporary failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    try {
      await deleteReservation(qamfCenterId, existing.qamfReservationId);
      console.log(`[reschedule] neonId=${neonId} deleted old QAMF ${existing.qamfReservationId}`);
    } catch (err) {
      // Non-fatal: QAMF reservation may have expired or already been cancelled.
      // We continue regardless so the new slot is claimed.
      console.warn(
        `[reschedule] neonId=${neonId} delete old QAMF ${existing.qamfReservationId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Build QAMF WebOffer.Options ──────────────────────────────────
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

  // ── Create new QAMF reservation ──────────────────────────────────
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
    console.error("[bowling/v2/reschedule] QAMF createReservation failed:", msg);
    return NextResponse.json(
      { error: `Reschedule failed: ${msg}` },
      { status: 502 },
    );
  }

  // ── Confirm the new QAMF reservation — MUST succeed ─────────────
  try {
    await setReservationStatus(qamfCenterId, newQamfId, "Confirmed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF error";
    console.error("[bowling/v2/reschedule] setReservationStatus failed:", msg);
    // Clean up the orphaned temporary reservation
    try {
      await deleteReservation(qamfCenterId, newQamfId);
    } catch { /* best effort */ }
    return NextResponse.json(
      { error: `QAMF confirm failed: ${msg}` },
      { status: 502 },
    );
  }

  // ── Update Neon ──────────────────────────────────────────────────
  await updateReservationReschedule(neonId, bookedAt, newQamfId);

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
    `;
  } catch (err) {
    console.error("[bowling/v2/reschedule] status reset failed:", err);
  }

  // ── Restore QAMF memo (shoe status, line items, deposit) ─────────
  try {
    const memo = await buildQamfMemo(neonId);
    if (memo) {
      await patchReservation(qamfCenterId, newQamfId, { Notes: memo });
    }
  } catch (err) {
    console.warn("[bowling/v2/reschedule] memo patch failed:", err instanceof Error ? err.message : err);
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

  return NextResponse.json({ id: neonId, bookedAt, qamfReservationId: newQamfId });
}
