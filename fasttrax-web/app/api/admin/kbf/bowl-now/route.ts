import { NextRequest, NextResponse } from "next/server";
import {
  getReservation,
  setReservationCustomer,
  setReservationStatus,
  setLaneStatus,
  setLanePlayers,
} from "@/lib/qamf-bowling";
import {
  insertBowlingReservation,
  insertReservationPlayers,
  type PlayerInput,
} from "@/lib/bowling-db";
import { createWalkinDayofOrder } from "@/lib/bowling-walkin-order";
import { processLaneOpen } from "@/lib/bowling-lane-open";
import { upsertMemberPref, linkPhoneByEmail } from "@/lib/kbf-prefs";
import { sql } from "@/lib/db";

/**
 * POST /api/admin/kbf/bowl-now
 *
 * Confirm a TEMPORARY hold and open the lane. Expects a qamfId
 * from a prior POST /api/admin/kbf/hold call.
 *
 *   1. Confirm QAMF (attach customer + set Confirmed)
 *   2. Insert Neon reservation + players
 *   3. Create Square day-of order (shoe line items for KDS)
 *   4. Open lane (Arrive → Ready → Running)
 *   5. KDS trigger (SHIPMENT fulfillment + shoe routing)
 *   6. Save prefs + link phone
 */

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

export const maxDuration = 60;

interface BowlerInput {
  name: string;
  kbfPassId?: number;
  kbfMemberSlot?: number;
  kbfRelation?: "kid" | "family";
  shoeSize?: string | null;
  bumpers?: boolean;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    centerCode,
    qamfId,
    laneNumber,
    bowlers,
    guestName,
    guestEmail,
    guestPhone,
    linkPhone,
  } = body as {
    centerCode: string;
    qamfId: string;
    laneNumber: number;
    bowlers: BowlerInput[];
    guestName: string;
    guestEmail: string;
    guestPhone?: string;
    linkPhone?: string;
  };

  const centerId = CENTER_CODE_TO_QAMF[centerCode];
  if (!centerId || !qamfId || !laneNumber || !bowlers?.length) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  // QAMF requires minutes as multiples of 5, seconds=0, ms=0
  const now = new Date();
  now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);
  const bookedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  const steps: string[] = [];
  let neonId: number | undefined;

  try {
    // ── Step 1: Confirm QAMF — attach customer then set Confirmed ───
    await setReservationCustomer(centerId, qamfId, {
      Guest: {
        Name: guestName,
        PhoneNumber: guestPhone || "0000000000",
        Email: guestEmail,
      },
    });
    await setReservationStatus(centerId, qamfId, "Confirmed");
    steps.push("qamf_confirmed");

    // ── Step 2: Insert Neon reservation + players ───────────────────
    const reservation = await insertBowlingReservation(
      {
        centerCode,
        productKind: "kbf",
        qamfReservationId: qamfId,
        bmiBillId: undefined,
        bmiReservationNumber: undefined,
        squareDepositOrderId: undefined,
        squareDepositPaymentId: undefined,
        squareDayofOrderId: undefined,
        squareGiftCardId: undefined,
        squareGiftCardGan: undefined,
        bookedAt,
        depositCents: 0,
        totalCents: 0,
        status: "confirmed",
        playerCount: bowlers.length,
        guestName,
        guestEmail,
        guestPhone: guestPhone || undefined,
        notes: `KBF: ${bowlers.filter((b) => b.kbfRelation === "kid").length} kids free | Admin walk-in`,
        bookingSource: "admin",
        squareCustomerId: undefined,
        squareLoyaltyRewardId: undefined,
        loyaltyAction: undefined,
        shortCode: undefined,
        dayofOrderSentAt: undefined,
        dayofOrderLane: undefined,
        dayofPaymentId: undefined,
        dayofOrderError: undefined,
        dayofOrderSource: undefined,
        preArrivalSentAt: undefined,
        laneReadySentAt: undefined,
      },
      [], // lines — empty for KBF
    );

    neonId = reservation.id;

    const playerInputs: PlayerInput[] = bowlers.map((b, i) => ({
      slot: i + 1,
      name: b.name,
      shoeSize: b.shoeSize || null,
      bumpers: b.bumpers ?? null,
      kbfPassId: b.kbfPassId || null,
      kbfMemberSlot: b.kbfMemberSlot || null,
      kbfRelation: b.kbfRelation || null,
      laneNumber,
    }));
    await insertReservationPlayers(neonId, playerInputs);
    steps.push("neon_inserted");

    // ── Step 3: Create Square day-of order (shoe line items for KDS) ─
    const walkinPlayers = bowlers.map((b) => ({
      name: b.name,
      shoeSize: b.shoeSize || undefined,
    }));
    const { dayofOrderId } = await createWalkinDayofOrder({
      locationId: centerCode,
      guestName,
      playerCount: bowlers.length,
      neonId,
      qamfReservationId: qamfId,
      players: walkinPlayers,
    });

    const q = sql();
    await q`UPDATE bowling_reservations SET square_dayof_order_id = ${dayofOrderId} WHERE id = ${neonId}`;
    steps.push("square_order_created");

    // ── Step 4: Open lane — Arrive + set players + Ready → Running ────
    await setReservationStatus(centerId, qamfId, "Arrived");
    const fullRez = await getReservation(centerId, qamfId);
    const bookedLanes = fullRez?.Lanes ?? [];

    for (const lane of bookedLanes) {
      // Set player names in QAMF so they show in Conqueror
      try {
        await setLanePlayers(
          centerId,
          qamfId,
          lane.Id,
          bowlers.map((b) => ({
            Name: b.name,
            ShoeSize: b.shoeSize || undefined,
            ActivateBumpers: b.bumpers ?? false,
          })),
        );
      } catch {
        /* best-effort — lane still opens without names */
      }

      try {
        await setLaneStatus(centerId, qamfId, lane.Id, "Ready");
      } catch {
        /* best-effort */
      }
      try {
        await setLaneStatus(centerId, qamfId, lane.Id, "Running");
      } catch {
        /* best-effort */
      }
    }
    steps.push("lane_opened");

    // ── Step 5: KDS trigger — SHIPMENT fulfillment + shoe routing ────
    const neonRez = {
      ...reservation,
      squareDayofOrderId: dayofOrderId,
    };
    await processLaneOpen({
      reservation: neonRez,
      laneNumbers: [laneNumber],
      idempotencyBase: `admin-bowl-now-${neonId}`,
      source: "webhook",
    });
    steps.push("kds_sent");

    // ── Step 6: Save KBF prefs + link phone ─────────────────────────
    for (const b of bowlers) {
      if (b.kbfPassId && b.kbfMemberSlot && b.kbfRelation) {
        await upsertMemberPref({
          passId: b.kbfPassId,
          memberSlot: b.kbfMemberSlot,
          relation: b.kbfRelation,
          wantBumpers: b.bumpers ?? null,
          shoeSizeLabel: b.shoeSize || null,
          lastUsedCenter:
            centerCode === "TXBSQN0FEKQ11" ? "fortmyers" : "naples",
        }).catch(() => void 0);
      }
    }

    if (linkPhone) {
      await linkPhoneByEmail(guestEmail, linkPhone).catch(() => void 0);
    }

    return NextResponse.json({
      ok: true,
      neonId,
      qamfId,
      laneNumber,
      laneLabel: `Lane ${laneNumber}`,
      steps,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Bowl Now failed";
    console.error(
      `[admin/kbf/bowl-now] failed at step ${steps.length}:`,
      msg,
    );
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        step: steps[steps.length - 1] ?? "init",
        steps,
        partial: { neonId, qamfId },
      },
      { status: 500 },
    );
  }
}
