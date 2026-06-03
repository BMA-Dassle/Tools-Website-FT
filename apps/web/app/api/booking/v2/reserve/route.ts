import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  createDepositAndCharge,
  rollbackDeposit,
  DepositPaymentError,
} from "~/features/booking/service/deposit";
import {
  lookupCatalogId,
  lookupCatalogIdByName,
  LOCATION_TAX,
  SQUARE_LOCATIONS,
} from "~/features/booking/data/square-catalog-map";
import { insertBowlingReservation, type ReservationProductKind } from "@/lib/bowling-db";

/**
 * POST /api/booking/v2/reserve
 *
 * Server-side endpoint for v2 race + attraction checkout. Replaces the
 * client-side two-step flow (Square pay → confirmation page payment/confirm).
 *
 * Flow:
 *   1. Build Square day-of order (catalog-backed line items + county tax)
 *   2. Compute deposit, charge via shared deposit service
 *   3. Confirm BMI payment (server-side, bigint-safe)
 *   4. Persist Neon reservation row
 *   5. Return confirmation data
 *
 * Credit orders ($0 BMI): skip deposit, confirm BMI with depositKind 2.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

// ── BMI auth (same pattern as /api/bmi proxy) ──────────────────────────

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

// ── Request schema ─────────────────────────────────────────────────────

interface CartItem {
  bmiProductId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

interface ReserveRequest {
  bmiBillId: string;
  bmiClientKey: string;
  depositPct: number;
  locationId: string;
  cardSourceId?: string;
  giftCardNonce?: string;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  rewardTierId?: string;
  rewardDiscountCents?: number;
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  bookingKind: "race" | "attraction";
  bookingMetadata?: Record<string, unknown>;
  cartItems: CartItem[];
  centerCode: string;
  /**
   * v2 $0 model: confirm the BMI bill for THIS amount (its real total — race
   * heats are $0, so it's just the license / other BMI-priced lines), decoupled
   * from the full Square charge. 0 → confirm as a $0 credit. Omitted on the
   * legacy path (falls back to the Square day-of total).
   */
  bmiConfirmAmountCents?: number;
}

// ── Resolve location from brand + center ───────────────────────────────

function resolveLocationId(centerCode: string, bookingKind: "race" | "attraction"): string {
  if (bookingKind === "race") return SQUARE_LOCATIONS.FASTTRAX_FM;
  if (centerCode === "naples") return SQUARE_LOCATIONS.HEADPINZ_NAP;
  return SQUARE_LOCATIONS.HEADPINZ_FM;
}

// ── Route handler ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReserveRequest;

    // ── Validate ────────────────────────────────────────────────────────
    if (!body.bmiBillId) {
      return NextResponse.json({ error: "bmiBillId required" }, { status: 400 });
    }
    if (!body.contact?.firstName || !body.contact?.email) {
      return NextResponse.json({ error: "contact info required" }, { status: 400 });
    }
    if (!body.cartItems?.length) {
      return NextResponse.json({ error: "cartItems required" }, { status: 400 });
    }
    if (!body.bookingKind || !["race", "attraction"].includes(body.bookingKind)) {
      return NextResponse.json(
        { error: "bookingKind must be race or attraction" },
        { status: 400 },
      );
    }
    const clientKey = body.bmiClientKey || "headpinzftmyers";
    if (!ALLOWED_CLIENTS.has(clientKey)) {
      return NextResponse.json({ error: "Invalid BMI client key" }, { status: 400 });
    }

    const locationId = body.locationId || resolveLocationId(body.centerCode, body.bookingKind);
    const depositPct = body.depositPct ?? 100;
    const baseKey = randomBytes(8).toString("hex");
    const isCreditOrder = body.cartItems.every((ci) => ci.unitPriceCents === 0);
    // BMI confirm amount is decoupled from the Square charge: when the caller
    // passes an explicit bill total (the $0 model), confirm for that (0 = $0
    // credit); otherwise fall back to the legacy "Square total" behavior.
    const explicitConfirmCents = body.bmiConfirmAmountCents;
    const bmiAsCredit =
      explicitConfirmCents !== undefined ? explicitConfirmCents === 0 : isCreditOrder;

    // ── Step 1: Build Square day-of order ───────────────────────────────
    const taxCatalogId = LOCATION_TAX[locationId];
    const orderTaxes = taxCatalogId
      ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
      : [];

    const sqLineItems = body.cartItems.map((ci) => {
      const catalogId = lookupCatalogId(ci.bmiProductId) ?? lookupCatalogIdByName(ci.name);

      if (catalogId) {
        return {
          catalog_object_id: catalogId,
          quantity: String(ci.quantity),
          base_price_money: { amount: ci.unitPriceCents, currency: "USD" },
          // $0 model only: override the shared "Karting" catalog item's display
          // name per the registry row. (Square may keep the catalog name on some
          // API versions — verify on a test order; price + the shared catalog
          // categorization still apply.) Legacy/attraction lines are untouched.
          ...(body.bmiConfirmAmountCents !== undefined ? { name: ci.name } : {}),
        };
      }
      // Ad-hoc line item (unmapped product)
      console.warn(
        `[v2/reserve] No catalog mapping for BMI product ${ci.bmiProductId} (${ci.name}) — using ad-hoc line item`,
      );
      return {
        name: ci.name,
        quantity: String(ci.quantity),
        base_price_money: { amount: ci.unitPriceCents, currency: "USD" },
      };
    });

    const dayofOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `v2-dayof-${baseKey}`,
        order: {
          location_id: locationId,
          ...(body.squareCustomerId ? { customer_id: body.squareCustomerId } : {}),
          line_items: sqLineItems,
          ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
        },
      }),
    });
    const dayofOrderData = await dayofOrderRes.json();

    if (!dayofOrderRes.ok || dayofOrderData.errors) {
      const sqErr = dayofOrderData.errors?.[0];
      const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(dayofOrderData);
      console.error("[v2/reserve] day-of order failed:", detail);
      return NextResponse.json(
        { error: `Failed to create day-of order: ${detail}` },
        { status: 500 },
      );
    }

    const dayofOrderId: string = dayofOrderData.order?.id;
    if (!dayofOrderId) {
      return NextResponse.json({ error: "Day-of order returned no ID" }, { status: 500 });
    }
    let dayofTotalCents: number = dayofOrderData.order?.total_money?.amount ?? 0;

    // ── Step 1b: Loyalty reward (before deposit) ───────────────────────
    let loyaltyRewardId: string | undefined;
    const rewardDiscountCents = body.rewardDiscountCents ?? 0;

    if (body.rewardTierId && body.loyaltyAccountId && dayofOrderId && SQUARE_TOKEN) {
      try {
        const createRes = await fetch(`${SQUARE_BASE}/loyalty/rewards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            reward: {
              loyalty_account_id: body.loyaltyAccountId,
              reward_tier_id: body.rewardTierId,
              order_id: dayofOrderId,
            },
            idempotency_key: `reward-${dayofOrderId}-${body.rewardTierId}`,
          }),
        });
        const createData = await createRes.json();
        if (createRes.ok && createData.reward?.id) {
          loyaltyRewardId = createData.reward.id;
          console.log(
            `[v2/reserve] Loyalty reward created: ${loyaltyRewardId} (${rewardDiscountCents}c off)`,
          );

          // Re-fetch order total — Square adjusts it after reward attachment
          try {
            const orderRes = await fetch(`${SQUARE_BASE}/orders/${dayofOrderId}`, {
              headers: sqHeaders(),
            });
            if (orderRes.ok) {
              const orderData = await orderRes.json();
              const adjusted = orderData.order?.total_money?.amount;
              if (typeof adjusted === "number") {
                dayofTotalCents = adjusted;
              }
            }
          } catch {
            // Non-fatal — fall back to pre-reward total
          }
        } else {
          const err = createData.errors?.[0];
          console.error(`[v2/reserve] Reward creation failed: ${err?.code}: ${err?.detail}`);
        }
      } catch (err) {
        console.error("[v2/reserve] Loyalty reward error:", err);
        if (loyaltyRewardId) {
          await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
            method: "DELETE",
            headers: sqHeaders(),
          }).catch(() => {});
          loyaltyRewardId = undefined;
        }
      }
    }

    // If a reward discount was requested but the reward wasn't created, fail
    if (rewardDiscountCents > 0 && !loyaltyRewardId) {
      return NextResponse.json(
        {
          error: "Your reward couldn't be applied right now. Please try again.",
          code: "REWARD_FAILED",
        },
        { status: 422 },
      );
    }

    // ── Step 2: Deposit ─────────────────────────────────────────────────
    const depositCents = loyaltyRewardId
      ? Math.round((dayofTotalCents * depositPct) / 100)
      : Math.max(0, Math.round((dayofTotalCents * depositPct) / 100) - rewardDiscountCents);
    let depositResult: {
      depositOrderId: string | null;
      depositPaymentId: string | null;
      giftCardId: string | null;
      giftCardGan: string | null;
      gcApprovedCents: number;
      cardApprovedCents: number;
    } = {
      depositOrderId: null,
      depositPaymentId: null,
      giftCardId: null,
      giftCardGan: null,
      gcApprovedCents: 0,
      cardApprovedCents: 0,
    };

    // Charge the deposit whenever the Square total is positive — independent of
    // how BMI is confirmed. In the $0 model the BMI bill is $0 (credit) but
    // Square still charges the real registry price.
    if (depositCents > 0) {
      if (!body.cardSourceId && !body.giftCardNonce) {
        return NextResponse.json(
          { error: "cardSourceId or giftCardNonce required for paid orders" },
          { status: 400 },
        );
      }

      const ganSuffix = body.bmiBillId.slice(-8);
      const ganPrefix = body.bookingKind === "race" ? "RACE" : "ATTR";

      try {
        const dr = await createDepositAndCharge({
          amountCents: depositCents,
          locationId,
          cardSourceId: body.cardSourceId,
          giftCardNonce: body.giftCardNonce,
          squareCustomerId: body.squareCustomerId,
          ganPrefix,
          ganSuffix,
          note: `Deposit - ${ganPrefix}${ganSuffix} - ${new Date().toISOString().slice(0, 10)}`,
          baseKey,
        });
        depositResult = {
          depositOrderId: dr.depositOrderId,
          depositPaymentId: dr.depositPaymentId,
          giftCardId: dr.giftCardId,
          giftCardGan: dr.giftCardGan,
          gcApprovedCents: dr.gcApprovedCents,
          cardApprovedCents: dr.cardApprovedCents,
        };
      } catch (err) {
        if (err instanceof DepositPaymentError) {
          console.error("[v2/reserve] deposit payment failed:", err.code, err.message);
          return NextResponse.json({ error: err.friendlyMessage, code: err.code }, { status: 400 });
        }
        console.error("[v2/reserve] deposit failed:", err);
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Deposit failed" },
          { status: 500 },
        );
      }
    }

    // ── Step 3: Confirm BMI payment ─────────────────────────────────────
    // BMI orderId is a 17-digit bigint — NEVER use Number() or JSON.stringify().
    // Build the request body as raw text with template literal injection.
    let reservationNumber: string | null = null;
    let reservationCode: string | null = null;

    try {
      const token = await getBmiToken(clientKey);
      const paymentTime = new Date().toISOString();

      let bmiBody: string;
      if (bmiAsCredit) {
        bmiBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${paymentTime}","amount":0,"orderId":${body.bmiBillId},"depositKind":2}`;
      } else {
        // Explicit BMI bill total ($0 model: the license/other lines) when
        // provided, else the legacy Square day-of total.
        const confirmDollars =
          explicitConfirmCents !== undefined ? explicitConfirmCents / 100 : dayofTotalCents / 100;
        bmiBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${paymentTime}","amount":${confirmDollars},"orderId":${body.bmiBillId},"depositKind":0}`;
      }

      const bmiUrl = `${BMI_API_URL}/public-booking/${clientKey}/payment/confirm`;
      console.log(`[v2/reserve] BMI payment/confirm → ${bmiUrl}`);

      const bmiRes = await fetch(bmiUrl, {
        method: "POST",
        headers: bmiHeaders(token),
        body: bmiBody,
        cache: "no-store",
      });

      const bmiText = await bmiRes.text();
      if (!bmiRes.ok) {
        console.error(
          "[v2/reserve] BMI payment/confirm failed:",
          bmiRes.status,
          bmiText.slice(0, 200),
        );
        // Rollback deposit if BMI fails
        if (depositResult.depositOrderId) {
          await rollbackDeposit(depositResult.depositOrderId, {
            gc: undefined,
            card: depositResult.depositPaymentId ?? undefined,
          });
        }
        return NextResponse.json(
          { error: `BMI confirmation failed: ${bmiRes.status}` },
          { status: 500 },
        );
      }

      const bmiData = JSON.parse(bmiText);
      reservationNumber = bmiData.reservationNumber ?? null;
      reservationCode = bmiData.reservationCode ?? null;

      console.log(
        `[v2/reserve] BMI confirmed: reservationNumber=${reservationNumber} reservationCode=${reservationCode}`,
      );

      // BMI_AUTOCANCEL_WORKAROUND — remove when BMI fixes payment/confirm
      // Step 3b: Set project state to Confirmation (-3) via Pandora.
      //
      // BMI's payment/confirm records the payment but does NOT set the
      // project-level confirm flag. A system cron (userUpdatedId=-1)
      // auto-cancels unconfirmed projects ~168 min later.
      //
      // The projectId is orderId+1 (confirmed across multiple test
      // bookings 2026-06-02). Pandora's state endpoint accepts the
      // projectId and writes directly to Firebird.
      //
      // Workaround until BMI fixes payment/confirm.
      const projectIdNum = (Number(body.bmiBillId.slice(-10)) + 1).toString();
      const projectId = body.bmiBillId.slice(0, -projectIdNum.length) + projectIdNum;
      try {
        const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
        const pandoraLocationId = body.bookingKind === "race" ? "LAB52GY480CJF" : "TXBSQN0FEKQ11";
        const pandoraRes = await fetch(
          "https://bma-pandora-api.azurewebsites.net/v2/bmi/reservation/state",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${pandoraKey}`,
            },
            body: JSON.stringify({
              locationID: pandoraLocationId,
              projectId,
              stateID: "-3",
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        console.log(
          `[v2/reserve] Pandora project ${projectId} state → -3 (Confirmation): ${pandoraRes.ok ? "OK" : pandoraRes.status}`,
        );
      } catch (pandoraErr) {
        console.error("[v2/reserve] Pandora state update failed (non-fatal):", pandoraErr);
      }
    } catch (err) {
      console.error("[v2/reserve] BMI confirm error:", err);
      if (depositResult.depositOrderId) {
        await rollbackDeposit(depositResult.depositOrderId, {
          gc: undefined,
          card: depositResult.depositPaymentId ?? undefined,
        });
      }
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "BMI confirmation failed" },
        { status: 500 },
      );
    }

    // ── Step 4: Persist Neon reservation ────────────────────────────────
    let neonId: number | null = null;
    try {
      const centerCode = body.centerCode || "fort-myers";
      const reservation = await insertBowlingReservation(
        {
          centerCode,
          productKind: body.bookingKind as ReservationProductKind,
          bmiBillId: body.bmiBillId,
          bmiReservationNumber: reservationNumber ?? undefined,
          squareDepositOrderId: depositResult.depositOrderId ?? undefined,
          squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
          squareDayofOrderId: dayofOrderId,
          squareGiftCardId: depositResult.giftCardId ?? undefined,
          squareGiftCardGan: depositResult.giftCardGan ?? undefined,
          depositCents,
          totalCents: dayofTotalCents,
          status: "confirmed",
          bookedAt: new Date().toISOString(),
          playerCount: body.cartItems.reduce((s, ci) => s + ci.quantity, 0),
          guestName: `${body.contact.firstName} ${body.contact.lastName}`.trim(),
          guestEmail: body.contact.email,
          guestPhone: body.contact.phone,
          notes: `v2 ${body.bookingKind} booking`,
          bookingSource: "web",
          squareCustomerId: body.squareCustomerId ?? undefined,
          squareLoyaltyRewardId: loyaltyRewardId ?? undefined,
          rewardDiscountCents: loyaltyRewardId ? rewardDiscountCents : undefined,
          bookingMetadata: body.bookingMetadata ?? undefined,
        },
        body.cartItems.map((ci) => ({
          label: ci.name,
          quantity: ci.quantity,
          unitPriceCents: ci.unitPriceCents,
        })),
      );
      neonId = reservation.id;
      console.log(`[v2/reserve] Neon reservation ${neonId} inserted`);
    } catch (err) {
      // Non-fatal — BMI reservation is already confirmed, don't fail the whole flow
      console.error("[v2/reserve] Neon insert failed (non-fatal):", err);
    }

    // ── Response ────────────────────────────────────────────────────────
    return NextResponse.json({
      neonId,
      reservationNumber,
      reservationCode,
      giftCardGan: depositResult.giftCardGan,
      depositOrderId: depositResult.depositOrderId,
      dayofOrderId,
      dayofTotalCents,
      depositCents,
      remainingCents: dayofTotalCents - depositCents,
      paymentIds: {
        gc: depositResult.gcApprovedCents > 0 ? "applied" : null,
        card: depositResult.cardApprovedCents > 0 ? "applied" : null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[v2/reserve] unexpected error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
