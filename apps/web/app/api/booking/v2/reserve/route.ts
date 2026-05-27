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
    const dayofTotalCents: number = dayofOrderData.order?.total_money?.amount ?? 0;

    // ── Step 2: Deposit ─────────────────────────────────────────────────
    const depositCents = Math.round((dayofTotalCents * depositPct) / 100);
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

    if (depositCents > 0 && !isCreditOrder) {
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
      if (isCreditOrder) {
        bmiBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${paymentTime}","amount":0,"orderId":${body.bmiBillId},"depositKind":2}`;
      } else {
        bmiBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${paymentTime}","amount":${dayofTotalCents / 100},"orderId":${body.bmiBillId},"depositKind":0}`;
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
