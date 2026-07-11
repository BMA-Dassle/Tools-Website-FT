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
import { recordAdminAction } from "~/features/reservations-admin/audit";
import { centerLabel } from "~/features/reservations-admin/format";
import { getComboSpecial } from "~/features/combos/combo-specials";
import { sendBowlingTimeChangedAlert } from "~/features/vip-move-alerts/time-change.server";

/** Combo time shifts are same-day nudges: at most this far from the booked slot. */
const COMBO_SHIFT_WINDOW_MS = 60 * 60_000;
/** Too late to shift once the party is due on the lane. */
const COMBO_SHIFT_CUTOFF_MS = 5 * 60_000;

// Both center_code namespaces: Square location IDs (regular bowling rows)
// AND center slugs (combo bowling legs, race/attraction rows).
const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
  "fort-myers": 9172,
  naples: 3148,
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
 * Body: { neonId, bookedAt, webOfferId, optionId?, optionType?, comboTimeShift? }
 *
 * comboTimeShift: true is the DELIBERATE combo path (the VIP card's "Change
 * bowl time" button): bowling leg only, status confirmed, same ET day within
 * ±1h, and only until 5 min before the booked start. It skips the guest
 * confirmation resend (party is on-site mid-combo) and instead posts a
 * time-changed card to the VIP movement Teams chat. Without the flag, combo
 * legs stay hard-blocked (single-leg reschedules strand combos — 2026-07-03).
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
    comboTimeShift?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { neonId, bookedAt, webOfferId, optionId, optionType = "Game", comboTimeShift } = body;
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
  // Combo (VIP) legs are inseparable from their sibling leg (race heats in
  // BMI, shared gift card + deposit). Rescheduling only the bowling leg here
  // desyncs the combo — this is exactly what stranded a combo on 2026-07-03.
  // EXCEPTION: comboTimeShift is the deliberate, windowed nudge from the VIP
  // card's "Change bowl time" button — bowling leg only, tightly validated,
  // announced to the movement chat instead of the guest.
  if (existing.comboSpecialId) {
    if (!comboTimeShift) {
      return NextResponse.json(
        { error: "VIP combo legs cannot be rescheduled here — rebook the combo instead." },
        { status: 400 },
      );
    }
    if (existing.productKind !== "open" && existing.productKind !== "kbf") {
      return NextResponse.json(
        { error: "Only the combo's bowling leg can be time-shifted." },
        { status: 400 },
      );
    }
    if (existing.status !== "confirmed") {
      return NextResponse.json(
        { error: `Cannot shift a ${existing.status} bowling leg — lane already open or closed.` },
        { status: 400 },
      );
    }
    const oldMs = Date.parse(existing.bookedAt);
    const newMs = Date.parse(bookedAt);
    if (!Number.isFinite(oldMs) || !Number.isFinite(newMs)) {
      return NextResponse.json({ error: "invalid bookedAt" }, { status: 400 });
    }
    if (Date.now() >= oldMs - COMBO_SHIFT_CUTOFF_MS) {
      return NextResponse.json(
        { error: "Too late — bowling starts in under 5 minutes." },
        { status: 400 },
      );
    }
    const etDay = (ms: number) =>
      new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (etDay(oldMs) !== etDay(newMs) || Math.abs(newMs - oldMs) > COMBO_SHIFT_WINDOW_MS) {
      return NextResponse.json(
        { error: "Combo time shifts are limited to ±1 hour on the same day." },
        { status: 400 },
      );
    }
  }

  const qamfCenterId = CENTER_CODE_TO_QAMF[existing.centerCode];
  if (!qamfCenterId) {
    return NextResponse.json({ error: `unknown center: ${existing.centerCode}` }, { status: 400 });
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
      console.log(
        `[admin/reschedule] neonId=${neonId} deleted old QAMF ${existing.qamfReservationId}`,
      );
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
    await recordAdminAction({
      reservationId: neonId,
      action: "reschedule",
      outcome: "failed",
      detail: { fromBookedAt: existing.bookedAt, toBookedAt: bookedAt },
      error: msg,
    });
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
    } catch {
      /* best effort */
    }
    await recordAdminAction({
      reservationId: neonId,
      action: "reschedule",
      outcome: "failed",
      detail: { fromBookedAt: existing.bookedAt, toBookedAt: bookedAt },
      error: msg,
    });
    return NextResponse.json(
      { error: `QAMF failed to confirm new reservation: ${msg}` },
      { status: 502 },
    );
  }

  // ── Update Neon ────────────────────────────────────────────────────
  await updateReservationReschedule(neonId, bookedAt, newQamfId);

  await recordAdminAction({
    reservationId: neonId,
    action: "reschedule",
    outcome: "success",
    detail: {
      fromBookedAt: existing.bookedAt,
      toBookedAt: bookedAt,
      oldQamfId: existing.qamfReservationId ?? null,
      newQamfId,
      ...(comboTimeShift ? { comboTimeShift: true } : {}),
    },
  });

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

  let chatAlerted = false;
  if (existing.comboSpecialId) {
    // ── Combo shift: tell the movement chat, not the guest ─────────────
    // The party is on-site mid-combo; the manager communicates in person.
    // Best-effort — the reschedule already happened.
    chatAlerted = await sendBowlingTimeChangedAlert({
      guestName: existing.guestName ?? "Guest",
      playerCount: existing.playerCount,
      comboName: getComboSpecial(existing.comboSpecialId)?.name ?? "Ultimate VIP",
      oldIso: existing.bookedAt,
      newIso: bookedAt,
      lane: existing.dayofOrderLane,
      centerLabel: `HeadPinz ${centerLabel(existing.centerCode)}`,
    });
  } else {
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
    } catch {
      /* non-fatal */
    }
  }

  return NextResponse.json({
    success: true,
    bookedAt,
    qamfReservationId: newQamfId,
    chatAlerted,
  });
}
