import { NextRequest, NextResponse } from "next/server";
import { buildGanPrefix } from "@/lib/gan";
import { createDepositAndCharge, DepositPaymentError } from "~/features/booking/service/deposit";
import { bmiBillIsLive } from "~/features/booking/service/bmi-confirm";
import { reserveBaseKey } from "~/features/booking/service/reserve-idempotency";
import {
  lookupCatalogId,
  lookupCatalogIdByName,
  LOCATION_TAX,
  SQUARE_LOCATIONS,
} from "~/features/booking/data/square-catalog-map";
import {
  insertBowlingReservation,
  findReusableReservation,
  getBowlingReservationByBillId,
  updateBowlingReservationConfirmed,
  updateBowlingReservationConfirmFailed,
  updateBowlingReservationSquareIds,
  type ReservationProductKind,
} from "@/lib/bowling-db";
import redis from "@/lib/redis";
import {
  validateCreditRedemptions,
  deductCreditRedemptions,
  CreditRedemptionError,
} from "~/features/booking/service/race-credit-redeem";
import type { CreditRedemption } from "~/features/booking/data/race-credits";

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
  /**
   * v2 race credit redemption: one entry per redeemed heat. Each draws down one
   * credit from the racer's OWN balance. Validated against the live balance
   * before any charge (hard fail on mismatch); deducted after BMI confirm. The
   * redeemed heats' race lines arrive in cartItems at $0 (charged $0 by Square).
   */
  creditRedemptions?: CreditRedemption[];
}

// ── Resolve location from brand + center ───────────────────────────────

function resolveLocationId(centerCode: string, bookingKind: "race" | "attraction"): string {
  if (bookingKind === "race") return SQUARE_LOCATIONS.FASTTRAX_FM;
  if (centerCode === "naples") return SQUARE_LOCATIONS.HEADPINZ_NAP;
  return SQUARE_LOCATIONS.HEADPINZ_FM;
}

/**
 * Idempotent success response for an already-confirmed bill. Reads the
 * `bmi:confirmed` cache (written at confirm time) + the Neon row — NO Square or
 * BMI calls. Returns null when the bill hasn't been confirmed yet. Used by the
 * route-entry guard so a double-submit / retry returns the first call's result
 * instead of charging a second time.
 */
async function cachedReserveSuccess(billId: string): Promise<NextResponse | null> {
  let cached: unknown;
  try {
    cached = await redis.get(`bmi:confirmed:${billId}`);
  } catch {
    return null;
  }
  if (!cached) return null;
  let c: { reservationNumber?: string; reservationCode?: string };
  try {
    c = typeof cached === "string" ? JSON.parse(cached) : (cached as typeof c);
  } catch {
    return null;
  }
  const row = await getBowlingReservationByBillId(billId).catch(() => null);
  return NextResponse.json({
    neonId: row?.id ?? null,
    reservationNumber: c.reservationNumber ?? row?.bmiReservationNumber ?? null,
    reservationCode: c.reservationCode ?? null,
    giftCardGan: row?.squareGiftCardGan ?? null,
    depositOrderId: row?.squareDepositOrderId ?? null,
    dayofOrderId: row?.squareDayofOrderId ?? null,
    alreadyConfirmed: true,
  });
}

// ── Route handler ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let reserveLockKey: string | null = null;
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

    // ── Route-entry idempotency guard (keyed per BMI bill) ──────────────
    // 1) Already confirmed? Return the first call's cached result — no Square /
    //    BMI calls, no second charge. The v2 confirmation page and client
    //    retries both land here.
    const billId = body.bmiBillId;
    const preCached = await cachedReserveSuccess(billId);
    if (preCached) return preCached;

    // 2) In-flight? NX lock so two concurrent submits for the same bill can't
    //    both charge. Loser briefly waits for the winner's confirmed cache,
    //    then returns it — or 409 (never charges).
    const lockKey = `reserve:lock:${billId}`;
    let lockOk = false;
    try {
      lockOk = (await redis.set(lockKey, "1", "EX", 120, "NX")) === "OK";
    } catch {
      // Redis down — the deterministic baseKey + bmi:confirmed guard still
      // prevent a double charge; proceed without the lock.
      lockOk = true;
    }
    if (!lockOk) {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const cached = await cachedReserveSuccess(billId);
        if (cached) return cached;
      }
      return NextResponse.json(
        {
          error: "A booking for this reservation is already in progress.",
          code: "RESERVE_IN_PROGRESS",
        },
        { status: 409 },
      );
    }
    reserveLockKey = lockKey;

    const locationId = body.locationId || resolveLocationId(body.centerCode, body.bookingKind);
    const depositPct = body.depositPct ?? 100;
    // Deterministic idempotency seed: same bill → same Square keys on every
    // retry / double-submit, so all 7 keys replay the SAME order / payment /
    // gift card instead of creating duplicates. (Shared with the reconcile cron.)
    const baseKey = reserveBaseKey(billId);
    const isCreditOrder = body.cartItems.every((ci) => ci.unitPriceCents === 0);
    // BMI confirm amount is decoupled from the Square charge: when the caller
    // passes an explicit bill total (the $0 model), confirm for that (0 = $0
    // credit); otherwise fall back to the legacy "Square total" behavior.
    const explicitConfirmCents = body.bmiConfirmAmountCents;
    const bmiAsCredit =
      explicitConfirmCents !== undefined ? explicitConfirmCents === 0 : isCreditOrder;

    // ── Step 0a: Guard — never proceed on an auto-cancelled BMI bill ────
    // BMI strips a Pending-Online hold's products after the center's auto-cancel
    // timeout; a later payment/confirm then fails with BillNotFound. Detect it up
    // front and return a clean "time expired" (no charge, no confusing
    // BMI_CONFIRM_FAILED). Fail-open on a transient overview error so a BMI hiccup
    // never blocks a legitimate booking; the auto-cancel case returns a clean
    // empty overview, which IS caught.
    try {
      const live = await bmiBillIsLive(clientKey, billId);
      if (!live) {
        return NextResponse.json(
          {
            error:
              "Your held time expired before checkout, so nothing was charged. Please go back and choose a time again.",
            code: "BILL_EXPIRED",
          },
          { status: 409 },
        );
      }
    } catch (e) {
      console.error("[v2/reserve] bill liveness check errored (failing open):", e);
    }

    // ── Step 0: Validate credit redemptions (charge-time re-eval) ───────
    // Re-check the racer's LIVE deposit balance before charging. A stale balance
    // (credit spent elsewhere since the page loaded) hard-fails here so we never
    // charge $0 / give away a free race on a credit they no longer hold.
    const creditRedemptions = body.creditRedemptions ?? [];
    if (creditRedemptions.length > 0) {
      try {
        await validateCreditRedemptions(creditRedemptions);
      } catch (err) {
        if (err instanceof CreditRedemptionError) {
          return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
        }
        throw err;
      }
    }

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
      const ganPrefix = buildGanPrefix("WEB", locationId);

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
          buyerEmail: body.contact.email,
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

    // ── Step 2b: Durable anchor (confirm_pending) ───────────────────────
    // Persist the reservation row BEFORE confirming BMI, so a CAPTURED deposit
    // is never stranded without a record. If BMI confirm later fails, this row
    // stays confirm_pending / confirm_failed and race-confirm-reconcile drives
    // it forward (the money is already on the gift card — never auto-refunded).
    // Idempotent: a retry for the same (bill, kind) reuses the existing row.
    const centerCode = body.centerCode || "fort-myers";
    let neonId: number | null = null;
    try {
      const existing = await findReusableReservation(
        body.bmiBillId,
        body.bookingKind as ReservationProductKind,
      );
      if (existing) {
        neonId = existing.id;
        // Backfill Square ids in case a prior attempt wrote the anchor before
        // the deposit produced them (e.g. a gift card recovered on a later pass).
        await updateBowlingReservationSquareIds(existing.id, {
          squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
          squareDayofOrderId: dayofOrderId,
          squareGiftCardId: depositResult.giftCardId ?? undefined,
          squareGiftCardGan: depositResult.giftCardGan ?? undefined,
        });
      } else {
        const anchor = await insertBowlingReservation(
          {
            centerCode,
            productKind: body.bookingKind as ReservationProductKind,
            bmiBillId: body.bmiBillId,
            squareDepositOrderId: depositResult.depositOrderId ?? undefined,
            squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
            squareDayofOrderId: dayofOrderId,
            squareGiftCardId: depositResult.giftCardId ?? undefined,
            squareGiftCardGan: depositResult.giftCardGan ?? undefined,
            depositCents,
            totalCents: dayofTotalCents,
            status: "confirm_pending",
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
        neonId = anchor.id;
      }
      console.log(`[v2/reserve] anchor reservation ${neonId} (confirm_pending)`);
    } catch (err) {
      // The anchor IS the recovery record. If we can't write it after capturing
      // the deposit, proceeding to BMI confirm would risk the exact "charged but
      // no row → never settles" regression this guards against. Fail BEFORE
      // confirming so the client retries — idempotent (same baseKey replays
      // Square; no double charge).
      console.error("[v2/reserve] anchor write failed:", err);
      return NextResponse.json(
        { error: "Could not persist reservation. Please retry.", code: "ANCHOR_WRITE_FAILED" },
        { status: 500 },
      );
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
        // Do NOT roll back: the deposit is CAPTURED (and on the happy path
        // already on the gift card) and a captured payment can't be voided. The
        // funds must stay for forward recovery. Mark the anchor confirm_failed;
        // race-confirm-reconcile retries BMI confirm (idempotent via baseKey).
        if (neonId != null) {
          await updateBowlingReservationConfirmFailed(
            neonId,
            `BMI confirm ${bmiRes.status}: ${bmiText.slice(0, 200)}`,
          );
        }
        return NextResponse.json(
          {
            error: `BMI confirmation failed: ${bmiRes.status}`,
            code: "BMI_CONFIRM_FAILED",
            neonId,
          },
          { status: 500 },
        );
      }

      const bmiData = JSON.parse(bmiText);
      reservationNumber = bmiData.reservationNumber ?? null;
      reservationCode = bmiData.reservationCode ?? null;

      console.log(
        `[v2/reserve] BMI confirmed: reservationNumber=${reservationNumber} reservationCode=${reservationCode}`,
      );

      // Idempotency cache for /api/booking/confirm. The v2 confirmation page calls
      // that endpoint on load; without this cache it MISSES and re-runs BMI
      // payment/confirm, and a SECOND payment/confirm reverts the project state
      // from Confirmation (-3) back to pending (-101). Pre-writing the same cache
      // entry booking/confirm uses makes the page's call a cache-HIT no-op
      // (alreadyConfirmed) so the -3 we set below sticks. Key/shape/TTL must match
      // app/api/booking/confirm/route.ts.
      if (reservationNumber) {
        try {
          await redis.set(
            `bmi:confirmed:${body.bmiBillId}`,
            JSON.stringify({
              reservationNumber,
              reservationCode: reservationCode ?? `r${body.bmiBillId}`,
              orderId: body.bmiBillId,
            }),
            "EX",
            86400 * 7,
          );
        } catch {
          // Redis down — non-fatal. Worst case the page re-confirms (the bug this
          // guards against) and the bmi-cancel-sweep cron recovers the state.
        }
      }

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
      // Captured deposit stays put (forward recovery, never auto-refund).
      if (neonId != null) {
        await updateBowlingReservationConfirmFailed(
          neonId,
          err instanceof Error ? err.message : "BMI confirm error",
        );
      }
      return NextResponse.json(
        {
          error: err instanceof Error ? err.message : "BMI confirmation failed",
          code: "BMI_CONFIRM_FAILED",
          neonId,
        },
        { status: 500 },
      );
    }

    // ── Step 3c: Deduct redeemed race credits (post-confirm) ────────────
    // Booking is confirmed — draw down one credit per redeemed heat. Idempotent
    // per heat (Redis guard); failures enqueue to the retry sweep. Never throws.
    if (creditRedemptions.length > 0) {
      await deductCreditRedemptions(creditRedemptions, { billId: body.bmiBillId });
    }

    // ── Step 4: Promote anchor → confirmed ──────────────────────────────
    // BMI is confirmed and the bmi:confirmed cache is written, so this is a
    // simple status flip on the row we anchored in Step 2b. Non-fatal: if it
    // fails, race-confirm-reconcile promotes the row (re-confirm is a cached
    // no-op via bmi:confirmed).
    if (neonId != null) {
      try {
        await updateBowlingReservationConfirmed(neonId, {
          bmiReservationNumber: reservationNumber ?? undefined,
        });
        console.log(`[v2/reserve] reservation ${neonId} → confirmed`);
      } catch (err) {
        console.error("[v2/reserve] confirmed-status update failed (non-fatal):", err);
      }
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
  } finally {
    // Release the per-bill in-flight lock (NX-acquired below). Best-effort: it
    // also self-expires after 120s, so a missed release never wedges a bill.
    if (reserveLockKey) {
      await redis.del(reserveLockKey).catch(() => {});
    }
  }
}
