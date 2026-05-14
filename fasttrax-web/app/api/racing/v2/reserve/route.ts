import { NextRequest, NextResponse } from "next/server";
import {
  createDepositOrder,
  syncBmiToSquareOrder,
  DepositOrderError,
  SQUARE_BASE,
  sqHeaders,
  type LineItemInput,
} from "@/lib/square-deposit-order";
import {
  insertBowlingReservation,
  updateBowlingReservationShortCode,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { shortenUrl } from "@/lib/short-url";
import {
  confirmBmiPayment,
  ALLOWED_BMI_CLIENTS,
  LOCATION_TO_BMI_CLIENT,
} from "@/lib/bmi-client";

/**
 * POST /api/racing/v2/reserve
 *
 * Server-side reservation for racing bookings. Replaces the old
 * OrderSummary → /api/square/pay → client-side payment/confirm chain.
 *
 * BMI is the pricing authority (Option B):
 *   1. Read BMI bill/overview for authoritative totals
 *   2. Sync BMI prices → Square day-of order (with metadata)
 *   3. Charge deposit via Square (if cash owed)
 *   4. Confirm payment with BMI (depositKind:0 for cash, :2 for credit-only)
 *   5. Persist Neon row with race details in attractionBookings JSONB
 *
 * Three payment paths:
 *   - Cash owed > 0  → full deposit flow (Square charge + gift card)
 *   - Credit-only     → skip Square, BMI confirm with depositKind:2
 *   - $0 free race    → skip Square, BMI confirm with depositKind:0
 */

// ── Square location map ────────────────────────────────────────────────────

const LOCATION_TO_SQUARE: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

const LOCATION_GAN_PREFIX: Record<string, string> = {
  fasttrax: "FT",
  headpinz: "HPFM",
  naples: "HPN",
};

// ── Types ──────────────────────────────────────────────────────────────────

interface HeatDetail {
  productName: string;
  productId?: string;
  proposalTime: string;
  quantity: number;
  racerNames?: string[];
  packageId?: string;
}

interface AddOnDetail {
  name: string;
  quantity: number;
  priceCents: number;
}

interface PovDetail {
  type: string;
  rookiePack?: boolean;
}

interface VerifiedRacer {
  personId: string;
  fullName: string;
}

interface PackResult {
  depositId?: string;
  creditCount?: number;
}

interface RacingReserveBody {
  locationKey: string;
  /** BMI bill ID — ALWAYS string, NEVER Number(). */
  bmiBillId: string;
  /** Square card token. Null/omitted for credit-only or $0. */
  sourceId?: string;
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  bookedAt: string;
  heats: HeatDetail[];
  addOns?: AddOnDetail[];
  pov?: PovDetail;
  racerType: "new" | "returning";
  verifiedRacers?: VerifiedRacer[];
  // Loyalty
  rewardTierId?: string;
  loyaltyAccountId?: string;
  rewardDiscountCents?: number;
  loyaltyAction?: "signup" | "existing";
  // Pack
  packResult?: PackResult;
  // Pre-created quote order
  existingDayofOrderId?: string;
  existingDayofTotalCents?: number;
  existingDepositCents?: number;
  // Square customer
  squareCustomerId?: string;
  notes?: string;
  clientKey?: string;
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RacingReserveBody;
    const {
      locationKey,
      bmiBillId,
      guest,
      bookedAt,
      heats,
      racerType,
    } = body;

    // ── Validate ──────────────────────────────────────────────────────
    if (!locationKey || !LOCATION_TO_SQUARE[locationKey]) {
      return NextResponse.json(
        { error: `Invalid location: ${locationKey}` },
        { status: 400 },
      );
    }
    if (!bmiBillId || typeof bmiBillId !== "string") {
      return NextResponse.json(
        { error: "bmiBillId required (as string)" },
        { status: 400 },
      );
    }
    if (!guest?.firstName || !guest?.email) {
      return NextResponse.json(
        { error: "guest.firstName and guest.email required" },
        { status: 400 },
      );
    }
    if (!heats?.length) {
      return NextResponse.json(
        { error: "At least one heat required" },
        { status: 400 },
      );
    }

    const squareLocationId = LOCATION_TO_SQUARE[locationKey];
    const bmiClientKey = body.clientKey || LOCATION_TO_BMI_CLIENT[locationKey] || "headpinzftmyers";
    if (!ALLOWED_BMI_CLIENTS.has(bmiClientKey)) {
      return NextResponse.json({ error: "Invalid BMI client" }, { status: 400 });
    }

    const guestName = `${guest.firstName} ${guest.lastName}`.trim();
    const totalRacers = heats.reduce((sum, h) => sum + h.quantity, 0);
    const heatTimes = heats.map((h) => h.proposalTime.slice(11, 16)).join(", ");

    // ── Square order metadata ─────────────────────────────────────────
    const metadata: Record<string, string> = {
      bmi_bill_id: bmiBillId,
      attraction: "racing",
      booking_type: racerType,
      racer_count: String(totalRacers),
    };

    // ── Sync BMI → Square ─────────────────────────────────────────────
    const syncResult = await syncBmiToSquareOrder({
      bmiBillId,
      bmiClientKey,
      locationId: squareLocationId,
      existingDayofOrderId: body.existingDayofOrderId,
      note: `Racing – ${totalRacers} racers – ${heatTimes}`,
      metadata,
      squareCustomerId: body.squareCustomerId,
    });

    // Add credit info to metadata now that we know the amount
    if (syncResult.creditAppliedCents > 0) {
      metadata.bmi_credit_cents = String(syncResult.creditAppliedCents);
    }

    let squareDepositOrderId: string | undefined;
    let squareDepositPaymentId: string | undefined;
    let squareDayofOrderId: string | undefined = syncResult.dayofOrderId;
    let squareGiftCardId: string | undefined;
    let squareGiftCardGan: string | undefined;
    let depositCents = 0;
    let finalTotalCents = syncResult.cashOwedCents;

    // ── Loyalty reward ────────────────────────────────────────────────
    const rewardDiscountCents = body.rewardDiscountCents ?? 0;
    let loyaltyRewardId: string | undefined;
    let rewardFailReason: string | undefined;
    let authoritativeTotalCents = body.existingDayofTotalCents ?? syncResult.cashOwedCents;

    if (body.rewardTierId && body.loyaltyAccountId && squareDayofOrderId) {
      try {
        const createRes = await fetch(`${SQUARE_BASE}/loyalty/rewards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            reward: {
              loyalty_account_id: body.loyaltyAccountId,
              reward_tier_id: body.rewardTierId,
              order_id: squareDayofOrderId,
            },
            idempotency_key: `reward-${squareDayofOrderId}-${body.rewardTierId}`,
          }),
        });
        const createData = await createRes.json();
        if (createRes.ok && createData.reward?.id) {
          loyaltyRewardId = createData.reward.id;
          console.log(`[racing/v2/reserve] Loyalty reward created: ${loyaltyRewardId}`);
        } else {
          const err = createData.errors?.[0];
          rewardFailReason = `create_failed: ${createRes.status} ${err?.code}`;
        }
      } catch (err) {
        rewardFailReason = `exception: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (rewardDiscountCents > 0) {
      rewardFailReason = "condition_false: missing fields or credit-only order";
    }

    // Guard: discount requires valid reward
    if (rewardDiscountCents > 0 && !loyaltyRewardId) {
      console.error(
        `[racing/v2/reserve] Reward discount ${rewardDiscountCents}c but no reward. reason=${rewardFailReason}`,
      );
      return NextResponse.json(
        { error: "Your reward couldn't be applied right now. Please try again.", code: "REWARD_FAILED" },
        { status: 422 },
      );
    }

    // Re-fetch order total after reward
    if (loyaltyRewardId && squareDayofOrderId) {
      try {
        const orderRes = await fetch(`${SQUARE_BASE}/orders/${squareDayofOrderId}`, {
          headers: sqHeaders(),
        });
        if (orderRes.ok) {
          const orderData = await orderRes.json();
          const ot = orderData.order?.total_money?.amount as number | undefined;
          if (ot !== undefined) authoritativeTotalCents = ot;
        }
      } catch { /* non-fatal */ }
    }

    const adjustedDepositCents = loyaltyRewardId
      ? Math.round(authoritativeTotalCents)  // 100% deposit for racing
      : undefined;

    // ── Square deposit flow (cash path only) ──────────────────────────
    const needsPayment =
      !syncResult.isCreditOnly &&
      !syncResult.isZeroDollar &&
      (adjustedDepositCents !== undefined ? adjustedDepositCents > 0 : syncResult.cashOwedCents > 0) &&
      body.sourceId;

    if (needsPayment) {
      // Build line items from BMI pricing
      const lineItems: LineItemInput[] = syncResult.lineItems.map((li) => ({
        name: li.name,
        quantity: String(li.quantity),
        basePriceMoney: { amount: li.unitPriceCents, currency: "USD" as const },
      }));

      const ganPrefix = LOCATION_GAN_PREFIX[locationKey] || "HP";
      const ganSuffix = bmiBillId.slice(-8).replace(/[^A-Za-z0-9]/g, "");

      const result = await createDepositOrder({
        sourceId: body.sourceId!,
        locationId: squareLocationId,
        depositPct: 100,
        lineItems,
        squareCustomerId: body.squareCustomerId,
        note: `Racing – ${totalRacers} racers – ${heatTimes} – Bill ${bmiBillId.slice(-6)}`,
        giftCardGan: `${ganPrefix}${ganSuffix}`,
        existingDayofOrderId: squareDayofOrderId,
        existingDayofTotalCents: authoritativeTotalCents,
        existingDepositCents: adjustedDepositCents ?? body.existingDepositCents,
        depositLineName: "Racing Reservation Deposit",
      });

      squareDepositOrderId = result.depositOrderId ?? undefined;
      squareDepositPaymentId = result.depositPaymentId ?? undefined;
      squareDayofOrderId = result.dayofOrderId;
      squareGiftCardId = result.giftCardId ?? undefined;
      squareGiftCardGan = result.giftCardGan ?? undefined;
      depositCents = result.depositPaidCents;
      finalTotalCents = result.dayofTotalCents;
    } else if (loyaltyRewardId && adjustedDepositCents === 0 && squareDayofOrderId) {
      // Reward covered everything
      depositCents = 0;
      finalTotalCents = authoritativeTotalCents;
    } else if (squareDayofOrderId) {
      finalTotalCents = body.existingDayofTotalCents ?? syncResult.cashOwedCents;
    }

    // Clean up loyalty reward on payment failure
    if (needsPayment && !squareDepositPaymentId && loyaltyRewardId) {
      await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
        method: "DELETE",
        headers: sqHeaders(),
      }).catch(() => {});
      loyaltyRewardId = undefined;
    }

    // ── BMI payment/confirm ───────────────────────────────────────────
    const depositKind: 0 | 2 = syncResult.isCreditOnly ? 2 : 0;
    const bmiResult = await confirmBmiPayment({
      clientKey: bmiClientKey,
      bmiBillId,
      depositKind,
    });

    const bmiConfirmed = bmiResult.confirmed;
    const bmiReservationNumber = bmiResult.reservationNumber;

    // ── Persist Neon row ──────────────────────────────────────────────
    let neonId = 0;
    try {
      const neonStatus: BowlingReservation["status"] =
        !bmiConfirmed && depositCents > 0 ? "confirm_pending" : "confirmed";

      // Build attractionBookings JSONB for admin board detail.
      // Base shape matches BowlingReservation["attractionBookings"] type;
      // racing-specific extras (racerNames, packageId, productId) are
      // additional JSONB properties — Postgres stores them, TS ignores them.
      const attractionBookings: BowlingReservation["attractionBookings"] = heats.map((h) => ({
        slug: "racing",
        name: h.productName,
        bmiOrderId: bmiBillId,
        bmiBillLineId: null,
        squareCatalogObjectId: null,
        quantity: h.quantity,
        totalPriceDollars: 0,
        timeSlot: h.proposalTime,
        timeLabel: h.proposalTime.slice(11, 16),
        // Extra racing fields stored in JSONB but not in TS type
        ...({ racerNames: h.racerNames ?? [], packageId: h.packageId ?? null, productId: h.productId ?? null } as Record<string, unknown>),
      }));

      // Add add-ons and POV to bookings JSONB
      if (body.addOns?.length) {
        for (const addon of body.addOns) {
          attractionBookings.push({
            slug: "racing-addon",
            name: addon.name,
            bmiOrderId: bmiBillId,
            bmiBillLineId: null,
            squareCatalogObjectId: null,
            quantity: addon.quantity,
            totalPriceDollars: addon.priceCents / 100,
            timeSlot: bookedAt,
            timeLabel: "",
          });
        }
      }
      if (body.pov) {
        attractionBookings.push({
          slug: "racing-pov",
          name: `POV${body.pov.rookiePack ? " (Rookie Pack)" : ""} – ${body.pov.type}`,
          bmiOrderId: bmiBillId,
          bmiBillLineId: null,
          squareCatalogObjectId: null,
          quantity: 1,
          totalPriceDollars: 0,
          timeSlot: bookedAt,
          timeLabel: "",
        });
      }

      const row = await insertBowlingReservation(
        {
          centerCode: squareLocationId,
          productKind: "racing" as BowlingReservation["productKind"],
          bmiBillId,
          bmiReservationNumber,
          depositCents,
          totalCents: finalTotalCents,
          status: neonStatus,
          bookedAt,
          playerCount: totalRacers,
          guestName,
          guestEmail: guest.email,
          guestPhone: guest.phone,
          notes: body.notes || `Racing – ${racerType} – ${totalRacers} racers`,
          squareDepositOrderId,
          squareDepositPaymentId,
          squareDayofOrderId,
          squareGiftCardId,
          squareGiftCardGan,
          squareCustomerId: body.squareCustomerId,
          squareLoyaltyRewardId: loyaltyRewardId,
          rewardDiscountCents: loyaltyRewardId ? rewardDiscountCents : 0,
          loyaltyAction: body.loyaltyAction,
          bookingSource: "web",
          attractionSlug: "racing" as BowlingReservation["attractionSlug"],
          attractionBookings,
        },
        [],
      );
      neonId = row.id;
    } catch (err) {
      console.error("[racing/v2/reserve] Neon insert failed:", err);
    }

    // ── Short code for confirmation URL ───────────────────────────────
    const confirmBase = "/book/race/confirmation";
    let shortCode: string | undefined;
    try {
      shortCode = await shortenUrl(`${confirmBase}?code=_TMP_`);
      await shortenUrl(`${confirmBase}?code=${shortCode}`, shortCode);
      if (neonId) {
        updateBowlingReservationShortCode(neonId, shortCode).catch((err) =>
          console.error("[racing/v2/reserve] short_code update failed:", err),
        );
      }
    } catch (err) {
      console.error("[racing/v2/reserve] shortenUrl failed:", err);
    }

    return NextResponse.json({
      neonId,
      bmiBillId,
      bmiReservationNumber: bmiReservationNumber ?? null,
      bmiConfirmed,
      squareDayofOrderId: squareDayofOrderId ?? null,
      squareDepositOrderId: squareDepositOrderId ?? null,
      squareDepositPaymentId: squareDepositPaymentId ?? null,
      squareGiftCardId: squareGiftCardId ?? null,
      squareGiftCardGan: squareGiftCardGan ?? null,
      depositPaidCents: depositCents,
      totalCents: finalTotalCents,
      creditAppliedCents: syncResult.creditAppliedCents,
      isCreditOnly: syncResult.isCreditOnly,
      shortCode: shortCode ?? null,
      confirmationPath: shortCode
        ? `${confirmBase}?code=${shortCode}`
        : neonId
          ? `${confirmBase}?neonId=${neonId}`
          : `${confirmBase}?billId=${bmiBillId}`,
    });
  } catch (err) {
    if (err instanceof DepositOrderError) {
      const response: Record<string, unknown> = { error: err.userMessage };
      if (err.code) response.code = err.code;
      if (err.detail) response.detail = err.detail;
      return NextResponse.json(response, { status: err.statusCode });
    }
    console.error("[racing/v2/reserve] Unexpected error:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
