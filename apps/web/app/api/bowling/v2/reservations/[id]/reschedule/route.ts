import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingReservation,
  getKbfRedeemedMembers,
  getReservationPlayersWithShoeAllowance,
} from "@/lib/bowling-db";
import { cancelBmiAttractions } from "@/lib/bmi-attraction-cancel";
import { rescheduleQamfReservation } from "~/features/booking/service/qamf-reschedule";

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

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    return NextResponse.json({ error: "bookedAt and webOfferId are required" }, { status: 400 });
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

  // ── Shared QAMF delete->create->confirm core (title/memo preserving,
  //    double-book guarded) — see ~/features/booking/service/qamf-reschedule.
  const shift = await rescheduleQamfReservation({
    neonId,
    qamfCenterId,
    existing,
    bookedAt,
    webOfferId,
    optionId,
    optionType,
    logTag: "[bowling/v2/reschedule]",
  });
  if (!shift.ok) {
    return NextResponse.json({ error: shift.error }, { status: shift.httpStatus });
  }
  const newQamfId = shift.newQamfId;

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
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ id: neonId, bookedAt, qamfReservationId: newQamfId });
}
