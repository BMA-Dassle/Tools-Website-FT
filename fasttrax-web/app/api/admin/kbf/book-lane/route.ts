import { NextRequest, NextResponse } from "next/server";
import {
  createReservation,
  setReservationCustomer,
  setReservationStatus,
  type NewReservationInput,
} from "@/lib/qamf-bowling";
import {
  getBowlingExperiences,
  insertBowlingReservation,
  insertReservationPlayers,
  getKbfRedeemedMembers,
  type PlayerInput,
} from "@/lib/bowling-db";
import { upsertMemberPref, linkPhoneByEmail } from "@/lib/kbf-prefs";

/**
 * POST /api/admin/kbf/book-lane
 *
 * Create a future KBF reservation. Simpler than bowl-now — steps 1–5 only:
 *   1. Validate redemption cap
 *   2. Load KBF experience
 *   3. Create QAMF reservation (BookForLater, no lane)
 *   4. Confirm QAMF
 *   5. Insert Neon reservation + players + save prefs
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
    bookedAt: rawBookedAt,
    bowlers,
    guestName,
    guestEmail,
    guestPhone,
    linkPhone,
  } = body as {
    centerCode: string;
    bookedAt: string;
    bowlers: BowlerInput[];
    guestName: string;
    guestEmail: string;
    guestPhone?: string;
    /** Phone collected at desk — link to KBF account for online booking */
    linkPhone?: string;
  };

  const centerId = CENTER_CODE_TO_QAMF[centerCode];
  if (!centerId) {
    return NextResponse.json({ error: "Invalid centerCode" }, { status: 400 });
  }
  if (!bowlers?.length || !rawBookedAt) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  // QAMF requires minutes as multiples of 5, seconds=0, ms=0
  const bookedAtDate = new Date(rawBookedAt);
  bookedAtDate.setMinutes(Math.floor(bookedAtDate.getMinutes() / 5) * 5, 0, 0);
  const bookedAt = bookedAtDate.toISOString().replace(/\.\d{3}Z$/, "Z");

  const steps: string[] = [];
  let qamfId: string | undefined;
  let neonId: number | undefined;

  try {
    // ── Step 1: Validate redemption cap ─────────────────────────────
    const bookedDate = new Date(bookedAt).toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    const kbfPairs = bowlers
      .filter((b) => b.kbfPassId && b.kbfMemberSlot)
      .map((b) => ({ passId: b.kbfPassId!, slot: b.kbfMemberSlot! }));
    if (kbfPairs.length > 0) {
      const redeemed = await getKbfRedeemedMembers(bookedDate, kbfPairs);
      if (redeemed.length > 0) {
        const names = bowlers
          .filter((b) =>
            redeemed.some(
              (r) =>
                r.passId === b.kbfPassId && r.slot === b.kbfMemberSlot,
            ),
          )
          .map((b) => b.name);
        return NextResponse.json(
          { error: `Already booked that day: ${names.join(", ")}` },
          { status: 409 },
        );
      }
    }
    steps.push("validated");

    // ── Step 2: Load KBF experience ─────────────────────────────────
    const experiences = await getBowlingExperiences(centerCode, "kbf");
    const kbfExp = experiences.find(
      (e) => e.slug === "kbf-regular" || (!e.isVip && e.kind === "kbf"),
    );
    if (!kbfExp || !kbfExp.qamfWebOfferId) {
      return NextResponse.json(
        { error: "KBF experience not configured for this center" },
        { status: 500 },
      );
    }
    steps.push("experience_loaded");

    // ── Step 3: Create QAMF reservation (BookForLater, no lane) ─────
    const optionsBlock: NewReservationInput["WebOffer"]["Options"] =
      kbfExp.qamfOptionType === "Game"
        ? { Game: [{ Id: kbfExp.qamfOptionId! }] }
        : kbfExp.qamfOptionType === "Unlimited"
          ? { Unlimited: [{ Id: kbfExp.qamfOptionId! }] }
          : { Time: [{ Id: kbfExp.qamfOptionId! }] };

    const qamfInput: NewReservationInput = {
      BookedAt: bookedAt,
      Title: `KBF Admin - ${guestName}`,
      Notes: "Admin booking",
      Customer: {
        Guest: {
          Name: guestName,
          PhoneNumber: guestPhone || "0000000000",
          Email: guestEmail,
        },
      },
      WebOffer: {
        Id: kbfExp.qamfWebOfferId,
        Options: optionsBlock,
        Services: ["BookForLater"],
      },
      TotalPlayers: bowlers.length,
      // No Lanes — QAMF assigns at arrival
    };

    const qamfRes = await createReservation(centerId, qamfInput);
    qamfId = qamfRes.Id;
    steps.push("qamf_created");

    // ── Step 4: Confirm QAMF (attach customer then set Confirmed) ───
    await setReservationCustomer(centerId, qamfId, {
      Guest: {
        Name: guestName,
        PhoneNumber: guestPhone || "0000000000",
        Email: guestEmail,
      },
    });
    await setReservationStatus(centerId, qamfId, "Confirmed");
    steps.push("qamf_confirmed");

    // ── Step 5: Insert Neon reservation + players ───────────────────
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
        notes: "Admin booking",
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

    // ── Save KBF prefs for next visit ───────────────────────────────
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
        }).catch(() => void 0); // Best-effort
      }
    }

    // ── Link phone to KBF account (enables SMS OTP for online booking)
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
    console.error(
      `[admin/kbf/book-lane] failed at step ${steps.length}:`,
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
