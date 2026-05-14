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

/**
 * POST /api/attractions/v2/reserve
 *
 * Server-side reservation endpoint for ALL non-bowling attractions
 * (laser tag, gel blaster, shuffleboard, duck pin — racing TBD Phase 7).
 *
 * Flow:
 *   1. Validate request
 *   2. Create Square deposit order via shared layer (or skip for $0)
 *   3. Insert Neon row with productKind = attractionSlug
 *   4. Confirm payment with BMI (server-side, raw orderId injection)
 *   5. Generate short code for confirmation URL
 *   6. Return IDs + confirmation path
 *
 * This replaces the old flow:
 *   client → /api/square/pay → redirect → client-side payment/confirm
 * with:
 *   client → /api/attractions/v2/reserve (does Square + BMI + Neon atomically)
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

// ── Square location map ─────────────────────────────────────────────────────

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

// ── Attraction slug → deposit line name ─────────────────────────────────────

const DEPOSIT_LINE_NAMES: Record<string, string> = {
  "laser-tag": "Laser Tag Reservation Deposit",
  "gel-blaster": "Gel Blaster Reservation Deposit",
  "shuffly": "Shuffleboard Reservation Deposit",
  "duck-pin": "Duck Pin Reservation Deposit",
  "racing": "Racing Reservation Deposit",
};

// ── Allowed attraction slugs ────────────────────────────────────────────────

const ALLOWED_SLUGS = new Set(["laser-tag", "gel-blaster", "shuffly", "duck-pin"]);
// Racing is excluded — it goes through Phase 7 with its own flow.

// ── Square loyalty helpers ─────────────────────────────────────────────────

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

function sqLoyaltyHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface ReserveBody {
  /** Attraction slug (laser-tag, gel-blaster, shuffly, duck-pin). */
  attractionSlug: string;
  /** Location key (fasttrax, headpinz, naples). */
  locationKey: string;
  /** BMI bill/order ID — ALWAYS a string, never coerce to Number. */
  bmiBillId: string;
  /** BMI reservation number (from payment/confirm response). */
  bmiReservationNumber?: string;
  /** ISO 8601 date/time for the booking. */
  bookedAt: string;
  /** Number of participants. */
  participantCount: number;

  /** Guest contact info. */
  guest: {
    name: string;
    email: string;
    phone: string;
  };

  /** Square payment token from Web Payments SDK. Required when totalCents > 0. */
  squareToken?: string;
  /** Square customer ID for loyalty. */
  squareCustomerId?: string;

  /**
   * Line items for the Square day-of order.
   * If empty/omitted and totalCents > 0, a single ad-hoc line item is created
   * from the attraction name + amount.
   */
  lineItems?: LineItemInput[];

  /** Total amount in cents (tax-inclusive). Used for deposit calculation. */
  totalCents: number;
  /** Deposit percentage (0–100). Defaults to 100 (full prepayment). */
  depositPct?: number;

  /** Pre-created day-of order ID (from /api/attractions/v2/reserve/quote). */
  existingDayofOrderId?: string;
  existingDayofTotalCents?: number;
  existingDepositCents?: number;

  /** Short human-readable name for the product (shown in Square notes). */
  productName?: string;
  /** Optional notes. */
  notes?: string;

  /** BMI client key override (defaults to location lookup). */
  clientKey?: string;

  // ── Loyalty (Phase 5) ──────────────────────────────────────────────
  /** Square Loyalty reward tier ID (the tier the customer selected to redeem). */
  rewardTierId?: string;
  /** Square Loyalty account ID. */
  loyaltyAccountId?: string;
  /** Discount amount in cents from the selected reward tier. */
  rewardDiscountCents?: number;
  /** How the customer engaged with loyalty: 'signup' or 'existing'. */
  loyaltyAction?: "signup" | "existing";
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReserveBody;

    // ── Validate ────────────────────────────────────────────────────
    const {
      attractionSlug,
      locationKey,
      bmiBillId,
      bookedAt,
      participantCount,
      guest,
      totalCents,
    } = body;

    if (!attractionSlug || !ALLOWED_SLUGS.has(attractionSlug)) {
      return NextResponse.json(
        { error: `Invalid attraction slug: ${attractionSlug}` },
        { status: 400 },
      );
    }
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
    if (!bookedAt || !guest?.name || !guest?.email) {
      return NextResponse.json(
        { error: "bookedAt, guest.name, and guest.email required" },
        { status: 400 },
      );
    }

    const squareLocationId = LOCATION_TO_SQUARE[locationKey];
    const bmiClientKey = body.clientKey || LOCATION_TO_BMI_CLIENT[locationKey] || "headpinzftmyers";
    if (!ALLOWED_CLIENTS.has(bmiClientKey)) {
      return NextResponse.json({ error: "Invalid BMI client" }, { status: 400 });
    }

    const depositPct = body.depositPct ?? 100;
    const productName = body.productName || attractionSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const depositLineName = DEPOSIT_LINE_NAMES[attractionSlug] || `${productName} Deposit`;

    // ── Square deposit flow ─────────────────────────────────────────
    let squareDepositOrderId: string | undefined;
    let squareDepositPaymentId: string | undefined;
    let squareDayofOrderId: string | undefined;
    let squareGiftCardId: string | undefined;
    let squareGiftCardGan: string | undefined;
    let depositCents = 0;
    let finalTotalCents = totalCents;

    const rewardDiscountCents = body.rewardDiscountCents ?? 0;
    let loyaltyRewardId: string | undefined;

    // ── Loyalty reward: create BEFORE payment ──────────────────────
    // If the customer selected a reward tier, create the reward (deducts
    // points immediately) and attach it to the day-of order (applies
    // discount). The deposit is then based on the reward-adjusted total.
    let rewardFailReason: string | undefined;

    if (rewardDiscountCents > 0) {
      console.log(
        `[attractions/v2/reserve] Reward requested: tierId=${body.rewardTierId} accountId=${body.loyaltyAccountId}` +
          ` dayofOrderId=${body.existingDayofOrderId} discount=${rewardDiscountCents}c`,
      );
    }

    if (body.rewardTierId && body.loyaltyAccountId && body.existingDayofOrderId && SQUARE_TOKEN) {
      try {
        // Create reward with order_id → ISSUED status, points deducted
        // immediately, reward attached to the day-of order. Do NOT call
        // /redeem — Square auto-redeems order-attached rewards at payment
        // time ("Cannot explicitly redeem rewards attached to an order").
        const createRes = await fetch(`${SQUARE_BASE}/loyalty/rewards`, {
          method: "POST",
          headers: sqLoyaltyHeaders(),
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
          console.log(`[attractions/v2/reserve] Loyalty reward created: ${loyaltyRewardId} (${rewardDiscountCents}c off)`);
        } else {
          const err = createData.errors?.[0];
          console.error(`[attractions/v2/reserve] Reward creation failed: ${err?.code}: ${err?.detail}`);
          rewardFailReason = `create_failed: ${createRes.status} ${err?.code}: ${err?.detail}`;
        }
      } catch (err) {
        console.error("[attractions/v2/reserve] Loyalty reward error:", err);
        rewardFailReason = `exception: ${err instanceof Error ? err.message : String(err)}`;
        if (loyaltyRewardId) {
          await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
            method: "DELETE",
            headers: sqLoyaltyHeaders(),
          }).catch(() => {});
          loyaltyRewardId = undefined;
        }
      }
    } else if (rewardDiscountCents > 0) {
      const missing = [
        !body.rewardTierId && "rewardTierId",
        !body.loyaltyAccountId && "loyaltyAccountId",
        !body.existingDayofOrderId && "existingDayofOrderId",
        !SQUARE_TOKEN && "SQUARE_TOKEN",
      ].filter(Boolean);
      rewardFailReason = `condition_false: missing ${missing.join(",")}`;
    }

    // ── Guard: reward discount requires a valid reward ──────────────
    if (rewardDiscountCents > 0 && !loyaltyRewardId) {
      console.error(
        `[attractions/v2/reserve] Reward discount ${rewardDiscountCents}c requested but no reward created` +
          ` — failing booking. reason=${rewardFailReason}`,
      );
      return NextResponse.json(
        {
          error: "Your reward couldn't be applied right now. Please try again.",
          code: "REWARD_FAILED",
        },
        { status: 422 },
      );
    }

    // ── Re-fetch order total after reward (authoritative price) ─────
    let authoritativeTotalCents = body.existingDayofTotalCents ?? totalCents;
    if (loyaltyRewardId && body.existingDayofOrderId) {
      try {
        const orderRes = await fetch(`${SQUARE_BASE}/orders/${body.existingDayofOrderId}`, {
          headers: sqLoyaltyHeaders(),
        });
        if (orderRes.ok) {
          const orderData = await orderRes.json();
          const orderTotal = orderData.order?.total_money?.amount as number | undefined;
          if (orderTotal !== undefined) {
            console.log(
              `[attractions/v2/reserve] Order total after reward: ${orderTotal}c (was ${authoritativeTotalCents}c)`,
            );
            authoritativeTotalCents = orderTotal;
          }
        }
      } catch {
        // Non-fatal — fall back to client-provided values
      }
    }

    // Recalculate deposit based on reward-adjusted total
    const effectiveDepositPct = depositPct;
    const adjustedDepositCents = loyaltyRewardId
      ? Math.round((authoritativeTotalCents * effectiveDepositPct) / 100)
      : undefined;

    // ── Square deposit flow ─────────────────────────────────────────
    const needsPayment =
      (adjustedDepositCents !== undefined ? adjustedDepositCents > 0 : totalCents > 0) &&
      body.squareToken;

    if (needsPayment) {
      // Build line items if not provided
      const lineItems = body.lineItems?.length
        ? body.lineItems
        : [
            {
              name: productName,
              quantity: String(participantCount),
              basePriceMoney: {
                amount: Math.round(totalCents / participantCount),
                currency: "USD" as const,
              },
            },
          ];

      const ganPrefix = LOCATION_GAN_PREFIX[locationKey] || "HP";
      // Use last 8 chars of bmiBillId for GAN readability
      const ganSuffix = bmiBillId.slice(-8).replace(/[^A-Za-z0-9]/g, "");

      const result = await createDepositOrder({
        sourceId: body.squareToken!,
        locationId: squareLocationId,
        depositPct,
        lineItems,
        squareCustomerId: body.squareCustomerId,
        note: `${productName} – ${bookedAt.slice(0, 10)} – Bill ${bmiBillId.slice(-6)}`,
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
      // Reward covered the full deposit — $0 charge, but day-of order exists
      squareDayofOrderId = body.existingDayofOrderId;
      depositCents = 0;
      finalTotalCents = authoritativeTotalCents;
    } else if (body.existingDayofOrderId) {
      // $0 booking with a pre-existing quote order
      squareDayofOrderId = body.existingDayofOrderId;
      finalTotalCents = body.existingDayofTotalCents ?? totalCents;
    }

    // If payment failed, clean up loyalty reward to return points
    if (needsPayment && !squareDepositPaymentId && loyaltyRewardId) {
      await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
        method: "DELETE",
        headers: sqLoyaltyHeaders(),
      }).catch(() => {});
      loyaltyRewardId = undefined;
    }

    // NOTE: Loyalty point accrual happens at arrival time (Phase 8),
    // NOT here — Square requires the order to be paid/completed before
    // AccumulateLoyaltyPoints will succeed, and the day-of order is still OPEN.

    // ── BMI payment/confirm (server-side) ───────────────────────────
    // Raw string injection for orderId precision — NEVER use Number() or JSON.stringify()
    // for the orderId field. The raw JSON template ensures the 18-digit ID is exact.
    let bmiReservationNumber: string | undefined = body.bmiReservationNumber;

    try {
      const bmiToken = await getBmiToken(bmiClientKey);
      const confirmUrl = `${BMI_API_URL}/public-booking/${bmiClientKey}/payment/confirm`;
      const confirmId = randomUUID();
      const confirmTime = new Date().toISOString();

      // Raw JSON body — orderId injected as raw string, not via JSON.stringify()
      const confirmBody = `{"id":"${confirmId}","paymentTime":"${confirmTime}","amount":0,"orderId":${bmiBillId},"depositKind":0}`;

      console.log(`[attractions/v2/reserve] BMI payment/confirm: ${confirmBody.substring(0, 200)}`);

      const confirmRes = await fetch(confirmUrl, {
        method: "POST",
        headers: bmiHeaders(bmiToken),
        body: confirmBody,
        cache: "no-store",
      });

      const confirmRaw = await confirmRes.text();
      console.log(`[attractions/v2/reserve] BMI confirm response: ${confirmRes.status} ${confirmRaw.substring(0, 300)}`);

      if (confirmRes.ok) {
        // Extract reservationNumber from response (raw text to avoid precision loss).
        // Format can be alphanumeric like "W35169" or numeric — match both.
        const rnMatch = confirmRaw.match(/"reservationNumber"\s*:\s*"([^"]+)"/);
        if (rnMatch) bmiReservationNumber = rnMatch[1];
      } else {
        console.error(
          `[attractions/v2/reserve] BMI payment/confirm failed: ${confirmRes.status} ${confirmRaw.substring(0, 500)}`,
        );
        // Non-fatal: booking is still in BMI as unpaid.
        // Neon row gets status = "confirm_pending" so a retry cron can pick it up.
      }
    } catch (err) {
      console.error("[attractions/v2/reserve] BMI payment/confirm error:", err);
    }

    const bmiConfirmed = !!bmiReservationNumber;

    // ── Persist to Neon ─────────────────────────────────────────────
    let neonId = 0;
    try {
      const neonStatus: BowlingReservation["status"] =
        !bmiConfirmed && depositCents > 0 ? "confirm_pending" : "confirmed";

      const row = await insertBowlingReservation(
        {
          centerCode: squareLocationId,
          productKind: attractionSlug as BowlingReservation["productKind"],
          bmiBillId,
          bmiReservationNumber,
          depositCents,
          totalCents: finalTotalCents,
          status: neonStatus,
          bookedAt,
          playerCount: participantCount,
          guestName: guest.name,
          guestEmail: guest.email,
          guestPhone: guest.phone,
          notes: body.notes,
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
          attractionSlug: attractionSlug as BowlingReservation["attractionSlug"],
        },
        [], // No reservation lines for attractions (single product)
      );
      neonId = row.id;
    } catch (err) {
      console.error("[attractions/v2/reserve] Neon insert failed:", err);
      // Non-fatal for the user — BMI has the booking. But log loudly.
    }

    // ── Short code for confirmation URL ─────────────────────────────
    const confirmBase = `/book/${attractionSlug}/confirmation`;
    let shortCode: string | undefined;
    try {
      shortCode = await shortenUrl(`${confirmBase}?code=_TMP_`);
      await shortenUrl(`${confirmBase}?code=${shortCode}`, shortCode);
      if (neonId) {
        updateBowlingReservationShortCode(neonId, shortCode).catch((err) =>
          console.error("[attractions/v2/reserve] short_code update failed (non-fatal):", err),
        );
      }
    } catch (err) {
      console.error("[attractions/v2/reserve] shortenUrl failed (non-fatal):", err);
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
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[attractions/v2/reserve] unexpected error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
