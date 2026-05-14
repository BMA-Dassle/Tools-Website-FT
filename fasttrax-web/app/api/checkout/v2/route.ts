import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  createDepositOrder,
  DepositOrderError,
  updateOrderMetadata,
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
  /** Guest contact — optional; checkout body.guest is the authoritative source. */
  guest?: { name: string; email: string; phone: string };
  lineItems: LineItemInput[];
  /** Square-format line items (catalog-backed) for the deposit order. */
  squareLineItems?: LineItemInput[];
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
  /** SMS opt-in — controls whether confirmation SMS is sent. */
  smsOptIn?: boolean;

  // ── Loyalty ──────────────────────────────────────────────────────
  rewardTierId?: string;
  loyaltyAccountId?: string;
  rewardDiscountCents?: number;
  loyaltyAction?: "signup" | "existing";

  // ── Bowling (QAMF) ──────────────────────────────────────────────
  /** When present, checkout also confirms a QAMF bowling hold. */
  bowlingHold?: BowlingHoldInput;

  // ── Racing data (for post-confirm pipeline) ───────────────────
  /** Compact racer assignments from the racing wizard (sessionStorage). */
  racerData?: Array<{
    name: string;
    personId?: string;
    product?: string;
    track?: string;
    heatStart?: string;
  }>;
  /** Primary returning racer's BMI personId. */
  primaryPersonId?: string;
  /** Package ID ("rookie-pack", "ultimate-qualifier-mega", etc.). */
  packageId?: string;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const isPreview = req.nextUrl.hostname.endsWith(".vercel.app") || req.nextUrl.hostname === "localhost";
  const debugSteps: Array<{ name: string; status: "ok" | "fail" | "skip"; ms?: number; detail?: string }> = [];
  const t = (label: string) => {
    const start = Date.now();
    return {
      ok: (detail?: string) => debugSteps.push({ name: label, status: "ok", ms: Date.now() - start, detail }),
      fail: (detail?: string) => debugSteps.push({ name: label, status: "fail", ms: Date.now() - start, detail }),
      skip: (detail?: string) => debugSteps.push({ name: label, status: "skip", detail }),
    };
  };

  try {
    // ── Infrastructure check (preview diagnostics) ────────────────
    const _infra = t("infra_check");
    const hasNeonDb = !!process.env.DATABASE_URL;
    const hasRedis = !!process.env.REDIS_URL;
    if (hasNeonDb && hasRedis) {
      _infra.ok("DATABASE_URL + REDIS_URL configured");
    } else {
      const missing = [!hasNeonDb && "DATABASE_URL", !hasRedis && "REDIS_URL"].filter(Boolean).join(", ");
      _infra.fail(`Missing env: ${missing}`);
      console.error(`[checkout/v2] INFRASTRUCTURE WARNING: Missing ${missing}. Neon inserts and/or shortcodes will fail.`);
    }

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
      const _loyaltyReward = t("loyalty_reward_create");
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
          _loyaltyReward.ok(loyaltyRewardId);
        } else {
          const err = createData.errors?.[0];
          rewardFailReason = `create_failed: ${createRes.status} ${err?.code}`;
          _loyaltyReward.fail(rewardFailReason);
        }
      } catch (err) {
        rewardFailReason = `exception: ${err instanceof Error ? err.message : String(err)}`;
        _loyaltyReward.fail(rewardFailReason);
      }
    } else if (rewardDiscountCents > 0) {
      rewardFailReason = "condition_false: missing fields";
      t("loyalty_reward_create").skip(rewardFailReason);
    } else {
      t("loyalty_reward_create").skip("no reward requested");
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
      const _orderRefetch = t("loyalty_order_refetch");
      try {
        const orderRes = await fetch(`${SQUARE_BASE}/orders/${body.existingDayofOrderId}`, { headers: sqHeaders() });
        if (orderRes.ok) {
          const orderData = await orderRes.json();
          const ot = orderData.order?.total_money?.amount as number | undefined;
          if (ot !== undefined) authoritativeTotalCents = ot;
          _orderRefetch.ok(`totalCents=${authoritativeTotalCents}`);
        } else {
          _orderRefetch.fail(`status=${orderRes.status}`);
        }
      } catch (err) {
        _orderRefetch.fail(err instanceof Error ? err.message : String(err));
      }
    } else {
      t("loyalty_order_refetch").skip("no reward or no existing order");
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
      const _sqDeposit = t("square_deposit_order");
      // Merge line items: bowling first, then BMI.
      // Use squareLineItems (catalog-backed, string qty) — NOT lineItems (internal DB IDs).
      const bowlingLineItems = hasBowling ? (bowlingHold!.squareLineItems ?? []) : [];
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
      _sqDeposit.ok(`deposit=${depositCents}c order=${squareDayofOrderId}`);
    } else if (loyaltyRewardId && adjustedDepositCents === 0 && body.existingDayofOrderId) {
      squareDayofOrderId = body.existingDayofOrderId;
      depositCents = 0;
      finalTotalCents = authoritativeTotalCents;
      t("square_deposit_order").skip("reward covers full amount");
    } else if (body.existingDayofOrderId) {
      squareDayofOrderId = body.existingDayofOrderId;
      finalTotalCents = body.existingDayofTotalCents ?? totalCents;
      t("square_deposit_order").skip("existing day-of order, no payment needed");
    } else {
      t("square_deposit_order").skip("no payment token or zero total");
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
      const _bmiConfirm = t("bmi_confirm");
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
          _bmiConfirm.ok(`resNum=${bmiReservationNumber}`);
        } else {
          console.error(`[checkout/v2] BMI confirm failed: ${confirmRes.status} ${confirmRaw.substring(0, 300)}`);
          _bmiConfirm.fail(`status=${confirmRes.status}`);
        }
      } catch (err) {
        console.error("[checkout/v2] BMI confirm error:", err);
        _bmiConfirm.fail(err instanceof Error ? err.message : String(err));
      }
    } else {
      t("bmi_confirm").skip("no BMI items");
    }

    const bmiConfirmed = hasBmi ? !!bmiReservationNumber : true;

    // ── QAMF confirm (if bowling in cart) ───────────────────────────
    let qamfConfirmed = false;

    if (hasBowling) {
      const bh = bowlingHold!;
      // 1. Attach customer — MUST be done before setReservationStatus
      const _qamfCustomer = t("qamf_customer");
      try {
        await setReservationCustomer(bh.centerId, bh.qamfReservationId, {
          Guest: {
            Name: guest.name,
            PhoneNumber: guest.phone.replace(/\D/g, ""),
            Email: guest.email,
          },
        });
        _qamfCustomer.ok();
      } catch (err) {
        _qamfCustomer.fail(err instanceof Error ? err.message : String(err));
        console.error("[checkout/v2] QAMF setCustomer error:", err);
      }

      // 2. Patch title + notes
      const _qamfPatch = t("qamf_patch");
      try {
        await patchReservation(bh.centerId, bh.qamfReservationId, {
          Title: `${guest.name} (${bh.players?.length || 1}p)`,
          Notes: bh.notes || `Unified checkout – ${productNames}`,
        });
        _qamfPatch.ok();
      } catch (err) {
        _qamfPatch.fail(err instanceof Error ? err.message : String(err));
        console.error("[checkout/v2] QAMF patchReservation error:", err);
      }

      // 3. Transition Temporary → Confirmed
      const _qamfStatus = t("qamf_status");
      try {
        qamfConfirmed = await setReservationStatus(
          bh.centerId,
          bh.qamfReservationId,
          "Confirmed",
        );
        _qamfStatus.ok(`confirmed=${qamfConfirmed}`);
        console.log(`[checkout/v2] QAMF confirm: ${bh.qamfReservationId} → ${qamfConfirmed}`);
      } catch (err) {
        _qamfStatus.fail(err instanceof Error ? err.message : String(err));
        console.error("[checkout/v2] QAMF confirm error:", err);
      }
    } else {
      t("qamf_customer").skip("no bowling");
      t("qamf_patch").skip("no bowling");
      t("qamf_status").skip("no bowling");
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

    // ── Bowling Neon row (with 1 retry for transient failures) ─────
    if (hasBowling) {
      const _neonBowling = t("neon_bowling");
      const bh = bowlingHold!;
      const bowlingStatus: BowlingReservation["status"] =
        !qamfConfirmed && depositCents > 0 ? "confirm_pending" : "confirmed";

      const bowlingInsertPayload = {
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
      };

      let bowlingInsertError: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 500)); // brief backoff
          const row = await insertBowlingReservation(bowlingInsertPayload, []);
          neonIds.push(row.id);
          if (!neonId) neonId = row.id;
          _neonBowling.ok(`id=${row.id}${attempt > 0 ? " (retry)" : ""}`);
          console.log(`[checkout/v2] Bowling Neon row: ${row.id} (group=${checkoutGroupId ?? "none"})${attempt > 0 ? " [retry succeeded]" : ""}`);
          bowlingInsertError = null;
          break;
        } catch (err) {
          bowlingInsertError = err instanceof Error ? err.message : String(err);
          if (attempt === 0) {
            console.warn(`[checkout/v2] Bowling Neon insert attempt 1 failed: ${bowlingInsertError} — retrying`);
          }
        }
      }
      if (bowlingInsertError) {
        _neonBowling.fail(bowlingInsertError);
        console.error(
          "[checkout/v2] Bowling Neon insert FAILED (all attempts):",
          bowlingInsertError,
          "| guest:", guest.email,
          "| qamfId:", bh.qamfReservationId,
          "| squareDepositOrderId:", squareDepositOrderId,
          "| squarePaymentId:", squareDepositPaymentId,
        );
      }
    } else {
      t("neon_bowling").skip("no bowling");
    }

    // ── BMI attraction Neon row (with 1 retry) ──────────────────────
    if (hasBmi) {
      const _neonBmi = t("neon_bmi");
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

      const bmiInsertPayload = {
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
      };

      let bmiInsertError: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
          const row = await insertBowlingReservation(bmiInsertPayload, []);
          neonIds.push(row.id);
          if (!neonId) neonId = row.id;
          _neonBmi.ok(`id=${row.id}${attempt > 0 ? " (retry)" : ""}`);
          console.log(`[checkout/v2] BMI Neon row: ${row.id} (group=${checkoutGroupId ?? "none"})${attempt > 0 ? " [retry succeeded]" : ""}`);
          bmiInsertError = null;
          break;
        } catch (err) {
          bmiInsertError = err instanceof Error ? err.message : String(err);
          if (attempt === 0) {
            console.warn(`[checkout/v2] BMI Neon insert attempt 1 failed: ${bmiInsertError} — retrying`);
          }
        }
      }
      if (bmiInsertError) {
        _neonBmi.fail(bmiInsertError);
        console.error(
          "[checkout/v2] BMI Neon insert FAILED (all attempts):",
          bmiInsertError,
          "| guest:", guest.email,
          "| bmiBillId:", bmiBillId,
          "| squareDepositOrderId:", squareDepositOrderId,
        );
      }
    } else {
      t("neon_bmi").skip("no BMI items");
    }

    // ── Fire confirmation notifications (server-side, non-blocking) ──
    // Same pattern as bowling/v2/reserve — fire from the server to avoid
    // browser abort during redirect.
    const notifOrigin = req.nextUrl.origin;
    const smsOptIn = body.smsOptIn ?? true;

    // Detect racing in the BMI cart — drives notification routing.
    // Racing carts get their notification from the post-confirm pipeline
    // (enriched with Express Lane, POV, waiver URL, package info).
    const isRacingCart = hasBmi && bmiItems.some((item) => {
      const n = item.name.toLowerCase();
      return n.includes("race") || n.includes("kart") || /(blue|red|mega).*track/i.test(n);
    });

    // Bowling confirmation email + SMS (awaited with 8s timeout to avoid Vercel
    // preview auth issues and ensure the notification actually fires).
    if (hasBowling && neonIds.length > 0) {
      const bowlingNeonId = neonIds[0]; // Bowling row is inserted first
      const _notifBowling = t("notif_bowling");
      try {
        const notifRes = await fetch(`${notifOrigin}/api/notifications/bowling-confirmation`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ neonId: bowlingNeonId, smsOptIn }),
          signal: AbortSignal.timeout(8000),
        });
        _notifBowling.ok(`status=${notifRes.status}`);
        console.log(`[checkout/v2] bowling notification: ${notifRes.status}`);
      } catch (err) {
        _notifBowling.fail(err instanceof Error ? err.message : String(err));
        console.error("[checkout/v2] bowling notification failed:", err);
      }
    } else {
      t("notif_bowling").skip(hasBowling ? "no neon rows" : "no bowling");
    }

    // Attraction / racing confirmation email + SMS
    // Skip for racing carts — the post-confirm pipeline fires an enriched
    // notification with Express Lane, POV codes, waiver URL, and package info.
    // The dedup key (notif:{billId}) means only one fires per bill.
    if (hasBmi && bmiReservationNumber && !isRacingCart) {
      const firstName = guest.name.split(/\s+/)[0] || guest.name;
      const _notifBooking = t("notif_booking");
      try {
        const bookNotifRes = await fetch(`${notifOrigin}/api/notifications/booking-confirmation`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: guest.email,
            phone: guest.phone,
            firstName,
            smsOptIn,
            reservationNumber: bmiReservationNumber,
            reservationName: guest.name,
            billId: bmiBillId,
            productNames: bmiNames,
            scheduledItems: bmiItems.map((item) => ({
              name: item.name,
              start: item.bookedAt,
              quantity: item.quantity,
            })),
            brand: locationKey === "fasttrax" ? "fasttrax" : "headpinz",
            location: locationKey,
          }),
          signal: AbortSignal.timeout(8000),
        });
        _notifBooking.ok(`status=${bookNotifRes.status}`);
        console.log(`[checkout/v2] booking notification: ${bookNotifRes.status}`);
      } catch (err) {
        _notifBooking.fail(err instanceof Error ? err.message : String(err));
        console.error("[checkout/v2] booking notification failed:", err);
      }
    } else {
      t("notif_booking").skip(!hasBmi ? "no BMI items" : !bmiReservationNumber ? "no reservation number" : "racing cart — uses post-confirm");
    }

    // ── Write metadata to Square day-of order (backbone for post-confirm) ──
    // After all confirms + Neon inserts, we have everything we need.
    // Square metadata: 60 keys max, 40-char keys, 500-char values.
    if (squareDayofOrderId) {
      // Build compact racer JSON: [{"n":"name","p":"pid","t":"track","h":"14:30"}]
      // ~70 chars/racer → fits ~6 in 500 chars
      let racerJson = "";
      if (body.racerData?.length) {
        const compact = body.racerData.map((r) => {
          const obj: Record<string, string> = { n: r.name };
          if (r.personId) obj.p = r.personId;
          if (r.track) obj.t = r.track;
          if (r.heatStart) {
            // Compress to HH:MM for space
            const tm = r.heatStart.match(/T(\d{2}:\d{2})/);
            if (tm) obj.h = tm[1];
          }
          return obj;
        });
        racerJson = JSON.stringify(compact);
        // Truncate to 500 chars if needed (unlikely for ≤6 racers)
        if (racerJson.length > 500) racerJson = racerJson.slice(0, 497) + "...]";
      }

      const metadata: Record<string, string> = {
        checkout_version: "v2",
        booking_type: hasBowling && hasBmi ? "mixed" : hasBowling ? "bowling" : isRacingCart ? "racing" : "attractions",
        location_key: locationKey,
        has_bowling: String(hasBowling),
        has_bmi: String(hasBmi),
        guest_name: guest.name.slice(0, 500),
        guest_email: guest.email.slice(0, 500),
        guest_phone: guest.phone.slice(0, 500),
        sms_opt_in: String(smsOptIn),
      };

      if (bmiBillId) metadata.bmi_bill_id = bmiBillId.slice(0, 500);
      if (bmiReservationNumber) metadata.reservation_number = bmiReservationNumber;
      if (bowlingHold?.qamfReservationId) metadata.qamf_id = bowlingHold.qamfReservationId;
      if (body.primaryPersonId) metadata.primary_person_id = body.primaryPersonId;
      if (body.packageId) metadata.package_id = body.packageId;
      if (racerJson) metadata.racers = racerJson;
      if (neonIds.length) metadata.neon_ids = neonIds.join(",");
      if (checkoutGroupId) metadata.checkout_group_id = checkoutGroupId;
      if (body.squareCustomerId) metadata.sq_customer_id = body.squareCustomerId;

      // Detect POV from BMI line items (productId 43746981)
      // The cart items don't carry productId, but the product name is stable enough
      const povQty = bmiItems.filter((item) => /pov/i.test(item.name)).reduce((s, i) => s + i.quantity, 0);
      if (povQty > 0) metadata.pov_qty = String(povQty);

      // Fire-and-forget — metadata is best-effort, booking is already confirmed
      const _sqMetadata = t("square_metadata");
      updateOrderMetadata(squareDayofOrderId, metadata).then((ok) => {
        if (ok) {
          _sqMetadata.ok(`keys=${Object.keys(metadata).length}`);
          console.log(`[checkout/v2] Square metadata written to ${squareDayofOrderId}`);
        } else {
          _sqMetadata.fail("updateOrderMetadata returned false");
          console.error(`[checkout/v2] Square metadata write failed for ${squareDayofOrderId}`);
        }
      }).catch((err) => {
        _sqMetadata.fail(err instanceof Error ? err.message : String(err));
        console.error("[checkout/v2] Square metadata write error:", err);
      });
    } else {
      t("square_metadata").skip("no day-of order");
    }

    // ── Fire post-confirm pipeline (racing orchestration — non-blocking) ──
    // Fires for ALL racing carts — including credit-only ($0) where no Square
    // order exists. The pipeline reads data from direct params (primary) and
    // Square metadata (fallback). Credit-only returning racers are exactly
    // the ones who need Express Lane detection + Pandora linking.
    if (isRacingCart) {
      const _notifRacing = t("notif_racing");
      try {
        const pcRes = await fetch(`${notifOrigin}/api/checkout/v2/post-confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            squareDayofOrderId: squareDayofOrderId || null,
            bmiBillId: bmiBillId || null,
            bmiReservationNumber: bmiReservationNumber || null,
            locationKey,
            clientKey: bmiClientKey,
            guest: { name: guest.name, email: guest.email, phone: guest.phone },
            smsOptIn,
            racerData: body.racerData || null,
            primaryPersonId: body.primaryPersonId || null,
            packageId: body.packageId || null,
            neonIds,
            checkoutGroupId: checkoutGroupId || null,
          }),
          signal: AbortSignal.timeout(12000),
        });
        _notifRacing.ok(`status=${pcRes.status}`);
        console.log(`[checkout/v2] post-confirm: ${pcRes.status}`);
      } catch (err) {
        _notifRacing.fail(err instanceof Error ? err.message : String(err));
        console.error("[checkout/v2] post-confirm failed:", err);
      }
    } else {
      t("notif_racing").skip("not a racing cart");
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
      bookingType: hasBowling && hasBmi ? "mixed" : hasBowling ? "bowling" : isRacingCart ? "racing" : "attractions",
      ...(isPreview ? { _debug: debugSteps } : {}),
    });
  } catch (err) {
    if (err instanceof DepositOrderError) {
      const response: Record<string, unknown> = { error: err.userMessage };
      if (err.code) response.code = err.code;
      if (err.detail) response.detail = err.detail;
      if (isPreview) response._debug = debugSteps;
      return NextResponse.json(response, { status: err.statusCode });
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[checkout/v2] unexpected error:", msg);
    const response: Record<string, unknown> = { error: msg };
    if (isPreview) response._debug = debugSteps;
    return NextResponse.json(response, { status: 500 });
  }
}
