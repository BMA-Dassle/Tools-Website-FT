import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  createDepositOrder,
  DepositOrderError,
  type LineItemInput,
} from "@/lib/square-deposit-order";
import {
  insertBowlingReservation,
  updateBowlingReservationShortCode,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { shortenUrl } from "@/lib/short-url";
import {
  setReservationCustomer,
  patchReservation,
  setReservationStatus,
} from "@/lib/qamf-bowling";

/**
 * POST /api/checkout/v2
 *
 * Unified multi-item checkout — handles ANY combination of:
 *   - Bowling (QAMF hold) — pricing from bowlingHold.lineItems
 *   - Attractions + Racing (BMI bill) — pricing from BMI bill/overview
 *
 * ONE Square deposit order with all merged line items.
 * Confirms both QAMF (bowling) and BMI (attractions/racing) in one call.
 * Creates linked Neon rows via checkout_group_id for mixed carts.
 */

// ── BMI config ──────────────────────────────────────────────────────────────

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

const ALLOWED_CLIENTS = new Set(["headpinzftmyers", "headpinznaples"]);

const tokenCache: Record<string, { token: string; expiry: number }> = {};

async function getBmiToken(clientKey: string): Promise<string> {
  const cached = tokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;

  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BMI-Subscription-Key": BMI_SUB_KEY,
    },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`BMI auth failed: ${res.status}`);

  const data = await res.json();
  const token = data.AccessToken || data.accessToken;
  const expiresIn = parseInt(data.ExpiresIn || data.expiresIn || "3600", 10);
  tokenCache[clientKey] = { token, expiry: Date.now() + expiresIn * 1000 };
  return token;
}

function bmiHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "BMI-Subscription-Key": BMI_SUB_KEY,
    "Content-Type": "application/json",
    "Accept-Language": "en",
  };
}

// ── Square ──────────────────────────────────────────────────────────────────

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
}

const LOCATION_TO_SQUARE: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

const LOCATION_TO_BMI_CLIENT: Record<string, string> = {
  fasttrax: "headpinzftmyers",
  headpinz: "headpinzftmyers",
  naples: "headpinznaples",
};

const LOCATION_GAN_PREFIX: Record<string, string> = {
  fasttrax: "FT",
  headpinz: "HPFM",
  naples: "HPN",
};

// ── Types ───────────────────────────────────────────────────────────────────

interface CartItemInput {
  attractionSlug: string;
  name: string;
  quantity: number;
  bookedAt: string;
  billLineId?: string;
}

/** Bowling hold data passed from the checkout page (read from sessionStorage). */
interface BowlingHoldInput {
  qamfReservationId: string;
  centerId: number;
  locationKey: string;
  squareCenterCode: string;
  webOfferId: string;
  optionId?: string;
  optionType?: string;
  bookedAt: string;
  service: string;
  players: Array<{ name?: string; shoeSize?: string | null }>;
  guest: { name: string; email: string; phone: string };
  lineItems: LineItemInput[];
  totalCents: number;
  depositCents: number;
  notes?: string;
  kind: string; // "open" | "kbf"
  experienceName: string;
  timeLabel: string;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  loyaltyAction?: "signup" | "existing";
  rewardTierId?: string;
  rewardDiscountCents?: number;
}

interface CheckoutBody {
  /** Single BMI bill ID — ALWAYS string. Optional for bowling-only. */
  bmiBillId?: string;
  /** True when returning-racer credits cover the entire BMI portion (depositKind:2). */
  bmiCreditOnly?: boolean;
  /** Location key (fasttrax, headpinz, naples). */
  locationKey: string;
  /** Cart items — one per booked attraction. Optional for bowling-only. */
  items?: CartItemInput[];

  /** Guest contact info. */
  guest: {
    name: string;
    email: string;
    phone: string;
  };

  /** Square payment token (required when totalCents > 0). */
  squareToken?: string;
  squareCustomerId?: string;

  /** Line items for the Square day-of order. */
  lineItems?: LineItemInput[];

  /** Total amount in cents (tax-inclusive, merged bowling + BMI). */
  totalCents: number;
  depositPct?: number;

  /** Pre-created day-of order from quote (may include bowling + BMI lines). */
  existingDayofOrderId?: string;
  existingDayofTotalCents?: number;
  existingDepositCents?: number;

  notes?: string;
  clientKey?: string;

  // ── Loyalty ──────────────────────────────────────────────────────
  rewardTierId?: string;
  loyaltyAccountId?: string;
  rewardDiscountCents?: number;
  loyaltyAction?: "signup" | "existing";

  // ── Bowling (QAMF) ──────────────────────────────────────────────
  /** When present, checkout also confirms a QAMF bowling hold. */
  bowlingHold?: BowlingHoldInput;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CheckoutBody;

    const { bmiBillId, locationKey, items, guest, totalCents, bowlingHold } = body;

    // ── Validate ────────────────────────────────────────────────────
    const hasBmi = !!bmiBillId && typeof bmiBillId === "string";
    const hasBowling = !!bowlingHold?.qamfReservationId;

    if (!hasBmi && !hasBowling) {
      return NextResponse.json(
        { error: "At least one of bmiBillId or bowlingHold required" },
        { status: 400 },
      );
    }
    if (!locationKey || !LOCATION_TO_SQUARE[locationKey]) {
      return NextResponse.json({ error: `Invalid location: ${locationKey}` }, { status: 400 });
    }
    if (hasBmi && (!items || !items.length)) {
      return NextResponse.json({ error: "items required when bmiBillId is present" }, { status: 400 });
    }
    if (!guest?.name || !guest?.email) {
      return NextResponse.json({ error: "guest.name and guest.email required" }, { status: 400 });
    }
    if (hasBowling && (!bowlingHold!.lineItems?.length) && (bowlingHold!.totalCents > 0)) {
      return NextResponse.json({ error: "bowlingHold.lineItems required when totalCents > 0" }, { status: 400 });
    }

    const squareLocationId = LOCATION_TO_SQUARE[locationKey];
    const bmiClientKey = body.clientKey || LOCATION_TO_BMI_CLIENT[locationKey] || "headpinzftmyers";
    if (hasBmi && !ALLOWED_CLIENTS.has(bmiClientKey)) {
      return NextResponse.json({ error: "Invalid BMI client" }, { status: 400 });
    }

    const depositPct = body.depositPct ?? 100;
    const bmiItems = items ?? [];
    const totalParticipants = bmiItems.reduce((s, i) => s + i.quantity, 0)
      + (hasBowling ? (bowlingHold!.players?.length || 1) : 0);

    // Build display names
    const bmiNames = bmiItems.map((i) => i.name);
    const bowlingName = hasBowling ? bowlingHold!.experienceName : "";
    const allNames = [...(bowlingName ? [bowlingName] : []), ...bmiNames];
    const productNames = allNames.join(" + ");
    const primarySlug = hasBmi ? bmiItems[0].attractionSlug : "bowling";

    // Use checkout_group_id when BOTH bowling and BMI are present
    const checkoutGroupId = (hasBmi && hasBowling) ? randomUUID() : undefined;

    // ── Loyalty reward (same pattern as attractions/v2/reserve) ─────
    const rewardDiscountCents = body.rewardDiscountCents ?? 0;
    let loyaltyRewardId: string | undefined;
    let rewardFailReason: string | undefined;
    let authoritativeTotalCents = body.existingDayofTotalCents ?? totalCents;

    if (body.rewardTierId && body.loyaltyAccountId && body.existingDayofOrderId && SQUARE_TOKEN) {
      try {
        const createRes = await fetch(`${SQUARE_BASE}/loyalty/rewards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            reward: {
              loyalty_account_id: body.loyaltyAccountId,
              reward_tier_id: body.rewardTierId,
              order_id: body.existingDayofOrderId,
            },
            idempotency_key: `reward-${body.existingDayofOrderId}-${body.rewardTierId}`,
          }),
        });
        const createData = await createRes.json();
        if (createRes.ok && createData.reward?.id) {
          loyaltyRewardId = createData.reward.id;
          console.log(`[checkout/v2] Loyalty reward created: ${loyaltyRewardId}`);
        } else {
          const err = createData.errors?.[0];
          rewardFailReason = `create_failed: ${createRes.status} ${err?.code}`;
        }
      } catch (err) {
        rewardFailReason = `exception: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (rewardDiscountCents > 0) {
      rewardFailReason = "condition_false: missing fields";
    }

    // Guard: discount requires valid reward
    if (rewardDiscountCents > 0 && !loyaltyRewardId) {
      console.error(`[checkout/v2] Reward discount ${rewardDiscountCents}c but no reward. reason=${rewardFailReason}`);
      return NextResponse.json(
        { error: "Your reward couldn't be applied right now. Please try again.", code: "REWARD_FAILED" },
        { status: 422 },
      );
    }

    // Re-fetch order total after reward
    if (loyaltyRewardId && body.existingDayofOrderId) {
      try {
        const orderRes = await fetch(`${SQUARE_BASE}/orders/${body.existingDayofOrderId}`, { headers: sqHeaders() });
        if (orderRes.ok) {
          const orderData = await orderRes.json();
          const ot = orderData.order?.total_money?.amount as number | undefined;
          if (ot !== undefined) authoritativeTotalCents = ot;
        }
      } catch { /* non-fatal */ }
    }

    const adjustedDepositCents = loyaltyRewardId
      ? Math.round((authoritativeTotalCents * depositPct) / 100)
      : undefined;

    // ── Square deposit flow ─────────────────────────────────────────
    let squareDepositOrderId: string | undefined;
    let squareDepositPaymentId: string | undefined;
    let squareDayofOrderId: string | undefined;
    let squareGiftCardId: string | undefined;
    let squareGiftCardGan: string | undefined;
    let depositCents = 0;
    let finalTotalCents = totalCents;

    const needsPayment =
      (adjustedDepositCents !== undefined ? adjustedDepositCents > 0 : totalCents > 0) &&
      body.squareToken;

    if (needsPayment) {
      // Merge line items: bowling first, then BMI
      const bowlingLineItems = hasBowling ? bowlingHold!.lineItems : [];
      const bmiLineItems = body.lineItems?.length
        ? body.lineItems
        : bmiItems.map((item) => ({
            name: item.name,
            quantity: String(item.quantity),
            basePriceMoney: {
              amount: Math.round(totalCents / Math.max(totalParticipants, 1)),
              currency: "USD" as const,
            },
          }));
      const mergedLineItems = [...bowlingLineItems, ...(hasBmi ? bmiLineItems : [])];

      // GAN suffix: prefer BMI bill ID (long), fall back to QAMF ID
      const ganPrefix = LOCATION_GAN_PREFIX[locationKey] || "HP";
      const ganSource = bmiBillId || bowlingHold?.qamfReservationId || randomUUID();
      const ganSuffix = ganSource.slice(-8).replace(/[^A-Za-z0-9]/g, "");

      // Note for Square order — human-readable summary
      const noteRef = bmiBillId ? `Bill ${bmiBillId.slice(-6)}` : `QAMF ${bowlingHold!.qamfReservationId}`;
      const depositLineName = hasBowling && !hasBmi
        ? "Bowling Reservation Deposit"
        : hasBmi && !hasBowling
          ? "Attraction Reservation Deposit"
          : "Unified Cart Deposit";

      const result = await createDepositOrder({
        sourceId: body.squareToken!,
        locationId: squareLocationId,
        depositPct,
        lineItems: mergedLineItems,
        squareCustomerId: body.squareCustomerId,
        note: `${productNames} – ${noteRef}`,
        giftCardGan: `${ganPrefix}${ganSuffix}`,
        existingDayofOrderId: body.existingDayofOrderId,
        existingDayofTotalCents: authoritativeTotalCents,
        existingDepositCents: adjustedDepositCents ?? body.existingDepositCents,
        depositLineName,
      });

      squareDepositOrderId = result.depositOrderId ?? undefined;
      squareDepositPaymentId = result.depositPaymentId ?? undefined;
      squareDayofOrderId = result.dayofOrderId;
      squareGiftCardId = result.giftCardId ?? undefined;
      squareGiftCardGan = result.giftCardGan ?? undefined;
      depositCents = result.depositPaidCents;
      finalTotalCents = result.dayofTotalCents;
    } else if (loyaltyRewardId && adjustedDepositCents === 0 && body.existingDayofOrderId) {
      squareDayofOrderId = body.existingDayofOrderId;
      depositCents = 0;
      finalTotalCents = authoritativeTotalCents;
    } else if (body.existingDayofOrderId) {
      squareDayofOrderId = body.existingDayofOrderId;
      finalTotalCents = body.existingDayofTotalCents ?? totalCents;
    }

    // Clean up loyalty reward on payment failure
    if (needsPayment && !squareDepositPaymentId && loyaltyRewardId) {
      await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
        method: "DELETE",
        headers: sqHeaders(),
      }).catch(() => {});
      loyaltyRewardId = undefined;
    }

    // ── BMI payment/confirm (if attractions / racing on the bill) ───
    let bmiReservationNumber: string | undefined;

    if (hasBmi) {
      try {
        const bmiToken = await getBmiToken(bmiClientKey);
        const confirmUrl = `${BMI_API_URL}/public-booking/${bmiClientKey}/payment/confirm`;
        const confirmId = randomUUID();
        const confirmTime = new Date().toISOString();

        // depositKind: 0 = cash payment, 2 = credit-only (returning racers)
        const depositKind: 0 | 2 = body.bmiCreditOnly ? 2 : 0;

        // Raw JSON — orderId injected as raw string for 18-digit precision
        const confirmBody = `{"id":"${confirmId}","paymentTime":"${confirmTime}","amount":0,"orderId":${bmiBillId},"depositKind":${depositKind}}`;

        console.log(`[checkout/v2] BMI payment/confirm: ${confirmBody.substring(0, 200)}`);

        const confirmRes = await fetch(confirmUrl, {
          method: "POST",
          headers: bmiHeaders(bmiToken),
          body: confirmBody,
          cache: "no-store",
        });

        const confirmRaw = await confirmRes.text();
        if (confirmRes.ok) {
          const rnMatch = confirmRaw.match(/"reservationNumber"\s*:\s*"([^"]+)"/);
          if (rnMatch) bmiReservationNumber = rnMatch[1];
        } else {
          console.error(`[checkout/v2] BMI confirm failed: ${confirmRes.status} ${confirmRaw.substring(0, 300)}`);
        }
      } catch (err) {
        console.error("[checkout/v2] BMI confirm error:", err);
      }
    }

    const bmiConfirmed = hasBmi ? !!bmiReservationNumber : true;

    // ── QAMF confirm (if bowling in cart) ───────────────────────────
    let qamfConfirmed = false;

    if (hasBowling) {
      const bh = bowlingHold!;
      try {
        // 1. Attach customer — MUST be done before setReservationStatus
        await setReservationCustomer(bh.centerId, bh.qamfReservationId, {
          Guest: {
            Name: guest.name,
            PhoneNumber: guest.phone.replace(/\D/g, ""),
            Email: guest.email,
          },
        });

        // 2. Patch title + notes
        await patchReservation(bh.centerId, bh.qamfReservationId, {
          Title: `${guest.name} (${bh.players?.length || 1}p)`,
          Notes: bh.notes || `Unified checkout – ${productNames}`,
        });

        // 3. Transition Temporary → Confirmed
        qamfConfirmed = await setReservationStatus(
          bh.centerId,
          bh.qamfReservationId,
          "Confirmed",
        );
        console.log(`[checkout/v2] QAMF confirm: ${bh.qamfReservationId} → ${qamfConfirmed}`);
      } catch (err) {
        console.error("[checkout/v2] QAMF confirm error:", err);
      }
    }

    // ── Persist Neon rows ───────────────────────────────────────────
    // Mixed carts get two rows linked by checkout_group_id.
    // Single-type carts get one row (no group ID needed).
    let neonId = 0;
    const neonIds: number[] = [];

    // Shared Square IDs — both rows reference the same deposit order
    const sharedSquareFields = {
      squareDepositOrderId,
      squareDepositPaymentId,
      squareDayofOrderId,
      squareGiftCardId,
      squareGiftCardGan,
      squareCustomerId: body.squareCustomerId,
      squareLoyaltyRewardId: loyaltyRewardId,
      rewardDiscountCents: loyaltyRewardId ? rewardDiscountCents : 0,
      loyaltyAction: body.loyaltyAction,
      bookingSource: "web" as const,
    };

    // ── Bowling Neon row ──────────────────────────────────────────
    if (hasBowling) {
      try {
        const bh = bowlingHold!;
        const bowlingStatus: BowlingReservation["status"] =
          !qamfConfirmed && depositCents > 0 ? "confirm_pending" : "confirmed";

        const row = await insertBowlingReservation(
          {
            centerCode: squareLocationId,
            productKind: (bh.kind === "kbf" ? "kbf" : "open") as BowlingReservation["productKind"],
            qamfReservationId: bh.qamfReservationId,
            depositCents: hasBmi ? bh.depositCents : depositCents,
            totalCents: bh.totalCents,
            status: bowlingStatus,
            bookedAt: bh.bookedAt,
            playerCount: bh.players?.length || 1,
            guestName: guest.name,
            guestEmail: guest.email,
            guestPhone: guest.phone,
            notes: bh.notes || `Bowling: ${bh.experienceName}`,
            ...sharedSquareFields,
            checkoutGroupId: checkoutGroupId,
          },
          [],
        );
        neonIds.push(row.id);
        if (!neonId) neonId = row.id;
        console.log(`[checkout/v2] Bowling Neon row: ${row.id} (group=${checkoutGroupId ?? "none"})`);
      } catch (err) {
        console.error("[checkout/v2] Bowling Neon insert failed:", err);
      }
    }

    // ── BMI attraction Neon row ────────────────────────────────────
    if (hasBmi) {
      try {
        const bmiStatus: BowlingReservation["status"] =
          !bmiConfirmed && depositCents > 0 ? "confirm_pending" : "confirmed";

        const attractionBookings = bmiItems.map((item) => ({
          slug: item.attractionSlug,
          name: item.name,
          bmiOrderId: bmiBillId!,
          bmiBillLineId: item.billLineId ?? null,
          squareCatalogObjectId: null,
          quantity: item.quantity,
          totalPriceDollars: 0,
          timeSlot: item.bookedAt,
          timeLabel: "",
        }));

        const row = await insertBowlingReservation(
          {
            centerCode: squareLocationId,
            productKind: bmiItems[0].attractionSlug as BowlingReservation["productKind"],
            bmiBillId: bmiBillId!,
            bmiReservationNumber,
            depositCents: hasBowling ? Math.max(0, depositCents - bowlingHold!.depositCents) : depositCents,
            totalCents: hasBowling ? Math.max(0, finalTotalCents - bowlingHold!.totalCents) : finalTotalCents,
            status: bmiStatus,
            bookedAt: bmiItems[0].bookedAt,
            playerCount: bmiItems.reduce((s, i) => s + i.quantity, 0),
            guestName: guest.name,
            guestEmail: guest.email,
            guestPhone: guest.phone,
            notes: body.notes || `Cart: ${bmiNames.join(" + ")}`,
            ...sharedSquareFields,
            attractionSlug: bmiItems[0].attractionSlug as BowlingReservation["attractionSlug"],
            attractionBookings,
            checkoutGroupId: checkoutGroupId,
          },
          [],
        );
        neonIds.push(row.id);
        if (!neonId) neonId = row.id;
        console.log(`[checkout/v2] BMI Neon row: ${row.id} (group=${checkoutGroupId ?? "none"})`);
      } catch (err) {
        console.error("[checkout/v2] BMI Neon insert failed:", err);
      }
    }

    // ── Short code (for admin links / email) ───────────────────────
    const confirmBase = "/book/checkout/confirmation";
    let shortCode: string | undefined;
    try {
      shortCode = await shortenUrl(`${confirmBase}?code=_TMP_`);
      await shortenUrl(`${confirmBase}?code=${shortCode}`, shortCode);
      if (neonId) {
        updateBowlingReservationShortCode(neonId, shortCode).catch((err) =>
          console.error("[checkout/v2] short_code update failed:", err),
        );
      }
    } catch (err) {
      console.error("[checkout/v2] shortenUrl failed:", err);
    }

    return NextResponse.json({
      neonId,
      neonIds,
      checkoutGroupId: checkoutGroupId ?? null,
      bmiBillId: bmiBillId ?? null,
      bmiReservationNumber: bmiReservationNumber ?? null,
      bmiConfirmed,
      qamfReservationId: bowlingHold?.qamfReservationId ?? null,
      qamfConfirmed,
      squareDayofOrderId: squareDayofOrderId ?? null,
      squareDepositOrderId: squareDepositOrderId ?? null,
      squareDepositPaymentId: squareDepositPaymentId ?? null,
      squareGiftCardGan: squareGiftCardGan ?? null,
      squareGiftCardId: squareGiftCardId ?? null,
      depositPaidCents: depositCents,
      totalCents: finalTotalCents,
      shortCode: shortCode ?? null,
      confirmationPath: shortCode
        ? `${confirmBase}?code=${shortCode}`
        : neonId
          ? `${confirmBase}?neonId=${neonId}`
          : null,
    });
  } catch (err) {
    if (err instanceof DepositOrderError) {
      const response: Record<string, unknown> = { error: err.userMessage };
      if (err.code) response.code = err.code;
      if (err.detail) response.detail = err.detail;
      return NextResponse.json(response, { status: err.statusCode });
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[checkout/v2] unexpected error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
