import { NextRequest, NextResponse } from "next/server";
import { setReservationCustomer, setReservationStatus } from "@/lib/qamf-bowling";
import {
  insertBowlingReservation,
  insertReservationPlayers,
  type PlayerInput,
} from "@/lib/bowling-db";
import { upsertMemberPref, linkPhoneByEmail } from "@/lib/kbf-prefs";

/**
 * POST /api/admin/kbf/book-lane
 *
 * Confirm a TEMPORARY hold and create the Neon reservation for a
 * future booking. Expects a qamfId from a prior POST /api/admin/kbf/hold.
 *
 *   1. Confirm QAMF (attach customer + set Confirmed)
 *   2. Insert Neon reservation + players
 *   3. Save prefs + link phone
 *
 * No lane specification, no Square order, no lane open, no KDS.
 */

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

export const maxDuration = 30;

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
    bookedAt: rawBookedAt,
    bowlers,
    guestName,
    guestEmail,
    guestPhone,
    linkPhone,
  } = body as {
    centerCode: string;
    qamfId: string;
    bookedAt: string;
    bowlers: BowlerInput[];
    guestName: string;
    guestEmail: string;
    guestPhone?: string;
    linkPhone?: string;
  };

  const centerId = CENTER_CODE_TO_QAMF[centerCode];
  if (!centerId || !qamfId || !bowlers?.length || !rawBookedAt) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // QAMF requires minutes as multiples of 5, seconds=0, ms=0
  const bookedAtDate = new Date(rawBookedAt);
  bookedAtDate.setMinutes(Math.floor(bookedAtDate.getMinutes() / 5) * 5, 0, 0);
  const bookedAt = bookedAtDate.toISOString().replace(/\.\d{3}Z$/, "Z");

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
        notes: `KBF: ${bowlers.filter((b) => b.kbfRelation === "kid").length} kids free | Admin booking`,
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
      laneNumber: null,
    }));
    await insertReservationPlayers(neonId, playerInputs);
    steps.push("neon_inserted");

    // ── Step 3: Save KBF prefs + link phone ─────────────────────────
    for (const b of bowlers) {
      if (b.kbfPassId && b.kbfMemberSlot && b.kbfRelation) {
        await upsertMemberPref({
          passId: b.kbfPassId,
          memberSlot: b.kbfMemberSlot,
          relation: b.kbfRelation,
          wantBumpers: b.bumpers ?? null,
          shoeSizeLabel: b.shoeSize || null,
          lastUsedCenter: centerCode === "TXBSQN0FEKQ11" ? "fortmyers" : "naples",
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
      bookedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Book Lane failed";
    console.error(`[admin/kbf/book-lane] failed at step ${steps.length}:`, msg);
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
