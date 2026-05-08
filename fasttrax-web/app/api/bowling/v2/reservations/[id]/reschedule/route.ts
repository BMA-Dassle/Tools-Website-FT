import { NextRequest, NextResponse } from "next/server";
import { createReservation, deleteReservation } from "@/lib/qamf-bowling";
import { getBowlingReservation, updateReservationReschedule } from "@/lib/bowling-db";

/**
 * PATCH /api/bowling/v2/reservations/[id]/reschedule
 *
 * Moves an existing KBF reservation to a new date/time:
 *  1. Load existing Neon record (must be a KBF reservation)
 *  2. Delete old QAMF reservation (best-effort — may have already expired)
 *  3. Create new QAMF reservation at the new time with identical guest/player data
 *  4. Update bowling_reservations: booked_at + qamf_reservation_id
 *  5. Return { id, bookedAt, qamfReservationId }
 *
 * Payment is not touched — Square deposit/day-of orders are unchanged.
 * A reschedule is a time-only change; if the customer wants different add-ons
 * they should cancel and rebook.
 *
 * Body:
 *   bookedAt    — ISO 8601 with ET offset from the new availability slot
 *   webOfferId  — QAMF web offer ID (from the slot, typically 152 for KBF)
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
  if (existing.productKind !== "kbf") {
    return NextResponse.json(
      { error: "only KBF reservations can be rescheduled via this endpoint" },
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

  // ── Delete old QAMF reservation (best-effort) ────────────────────
  if (existing.qamfReservationId) {
    try {
      await deleteReservation(qamfCenterId, existing.qamfReservationId);
    } catch {
      // Non-fatal: QAMF reservation may have expired or already been cancelled.
      // We continue regardless so the new slot is claimed.
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

  // ── Update Neon ──────────────────────────────────────────────────
  await updateReservationReschedule(neonId, bookedAt, newQamfId);

  return NextResponse.json({ id: neonId, bookedAt, qamfReservationId: newQamfId });
}
