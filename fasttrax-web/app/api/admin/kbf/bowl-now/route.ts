import { NextRequest, NextResponse } from "next/server";
import {
  createReservation,
  getReservation,
  setReservationCustomer,
  setReservationStatus,
  setLaneStatus,
  type NewReservationInput,
} from "@/lib/qamf-bowling";
import {
  getBowlingExperiences,
  insertBowlingReservation,
  insertReservationPlayers,
  getKbfRedeemedMembers,
  type PlayerInput,
} from "@/lib/bowling-db";
import { createWalkinDayofOrder } from "@/lib/bowling-walkin-order";
import { processLaneOpen } from "@/lib/bowling-lane-open";
import { upsertMemberPref, linkPhoneByEmail } from "@/lib/kbf-prefs";
import { sql } from "@/lib/db";

/**
 * POST /api/admin/kbf/bowl-now
 *
 * 8-step orchestration for immediate KBF bowling:
 *   1. Validate redemption cap
 *   2. Load KBF experience (QAMF offer IDs)
 *   3. Create QAMF reservation (PlayNow — QAMF auto-assigns lane)
 *   4. Confirm QAMF (attach customer + set Confirmed)
 *   5. Insert Neon reservation + players
 *   6. Create Square day-of order (shoe line items for KDS)
 *   7. Open lane (Arrive → Ready → Running)
 *   8. KDS trigger (SHIPMENT fulfillment + shoe routing)
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
    bowlers,
    guestName,
    guestEmail,
    guestPhone,
    linkPhone,
  } = body as {
    centerCode: string;
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
  if (!bowlers?.length) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  const steps: string[] = [];
  let qamfId: string | undefined;
  let neonId: number | undefined;

  try {
    // ── Step 1: Validate redemption cap ───────────────────────────────
    // No lane validation — QAMF auto-assigns the best available lane.
    const todayET = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    const kbfPairs = bowlers
      .filter((b) => b.kbfPassId && b.kbfMemberSlot)
      .map((b) => ({ passId: b.kbfPassId!, slot: b.kbfMemberSlot! }));
    if (kbfPairs.length > 0) {
      const redeemed = await getKbfRedeemedMembers(todayET, kbfPairs);
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
          { error: `Already played today: ${names.join(", ")}` },
          { status: 409 },
        );
      }
    }
    steps.push("validated");

    // ── Step 2: Load experience (get QAMF offer IDs) ────────────────
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

    // ── Step 3: Create QAMF reservation (PlayNow — QAMF picks lane) ──
    const now = new Date();
    // QAMF requires minutes as multiples of 5, seconds=0, ms=0
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);
    const bookedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");

    const optionsBlock: NewReservationInput["WebOffer"]["Options"] =
      kbfExp.qamfOptionType === "Game"
        ? { Game: [{ Id: kbfExp.qamfOptionId! }] }
        : kbfExp.qamfOptionType === "Unlimited"
          ? { Unlimited: [{ Id: kbfExp.qamfOptionId! }] }
          : { Time: [{ Id: kbfExp.qamfOptionId! }] };

    const qamfInput: NewReservationInput = {
      BookedAt: bookedAt,
      Title: `${guestName} (${bowlers.length}p)`,
      Notes: `KBF: ${bowlers.filter((b) => b.kbfRelation === "kid").length} kids free${bowlers.some((b) => b.kbfRelation === "family") ? `, ${bowlers.filter((b) => b.kbfRelation === "family").length} family free (FBF)` : ""} | Admin walk-in`,
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
        Services: ["PlayNow"],
      },
      TotalPlayers: bowlers.length,
      // No Lanes — QAMF auto-assigns the best available lane
    };

    const qamfRes = await createReservation(centerId, qamfInput);
    qamfId = qamfRes.Id;

    // Read the lane QAMF assigned from the creation response
    const assignedLane = qamfRes.Lanes?.[0]?.LaneNumber;
    if (!assignedLane) {
      return NextResponse.json(
        { error: "QAMF created the reservation but did not assign a lane" },
        { status: 500 },
      );
    }
    steps.push("qamf_created");

    // ── Step 4: Confirm QAMF — attach customer then set Confirmed ───
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
      laneNumber: assignedLane,
    }));
    await insertReservationPlayers(neonId, playerInputs);
    steps.push("neon_inserted");

    // ── Step 6: Create Square day-of order (shoe line items for KDS) ─
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

    // Update Neon with Square day-of order ID (no updateBowlingReservationField helper)
    const q = sql();
    await q`UPDATE bowling_reservations SET square_dayof_order_id = ${dayofOrderId} WHERE id = ${neonId}`;
    steps.push("square_order_created");

    // ── Step 7: Open lane — Arrive + get lane GUIDs + Ready → Running
    await setReservationStatus(centerId, qamfId, "Arrived");
    const fullRez = await getReservation(centerId, qamfId);
    const bookedLanes = fullRez?.Lanes ?? [];

    for (const lane of bookedLanes) {
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

    // ── Step 8: KDS trigger — SHIPMENT fulfillment + shoe routing ────
    const neonRez = {
      ...reservation,
      squareDayofOrderId: dayofOrderId,
    };
    await processLaneOpen({
      reservation: neonRez,
      laneNumbers: [assignedLane],
      idempotencyBase: `admin-bowl-now-${neonId}`,
      source: "webhook", // processLaneOpen only accepts "webhook" | "cron"
    });
    steps.push("kds_sent");

    // ── Save KBF prefs (shoe sizes, bumpers) for next visit ─────────
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
      laneNumber: assignedLane,
      laneLabel: `Lane ${assignedLane}`,
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
