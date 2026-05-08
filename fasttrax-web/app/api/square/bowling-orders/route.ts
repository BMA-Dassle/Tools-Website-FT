import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

/**
 * POST /api/square/bowling-orders
 *
 * Creates the Square order and payment for a bowling booking:
 *
 * 1. Day-of order   — full line items at catalog price + county sales tax,
 *                     left OPEN. Redeemed by staff at center when lanes open.
 *
 * 2. Deposit charge — standalone payment (no order attached) for depositCents.
 *                     autocomplete: true — captured immediately.
 *
 * 3. eGift card     — a new DIGITAL gift card is created and immediately loaded
 *                     with the exact charged amount. The card balance is the
 *                     ground truth for refunds: no tax-rounding mismatch is
 *                     possible. Staff at center can scan the GAN to apply it
 *                     against the day-of order balance.
 *
 * Tax:
 *   Location → county sales-tax catalog object:
 *     TXBSQN0FEKQ11 (HeadPinz Fort Myers)  → Lee County  6.5%
 *     PPTR5G2N0QXF7 (HeadPinz Naples)      → Collier Co. 6.0%
 *
 * Request body:
 * {
 *   sourceId:              string   — Square nonce from Web Payments SDK
 *   idempotencyKey?:       string   — caller-supplied UUID for dedup
 *   locationId:            string   — Square location ID (drives tax selection)
 *   depositPct?:           number   — deposit as % of tax-inclusive total (0–100, default 100)
 *   lineItems:             Array<{
 *     name:               string
 *     quantity:           string   — "1", "2", …
 *     catalogObjectId?:   string   — Square catalog item variation ID
 *     basePriceMoney:     { amount: number; currency: "USD" }
 *   }>
 *   squareCustomerId?:     string
 *   note?:                 string
 *   existingDayofOrderId?: string  — pre-created day-of order (skips step 1)
 *   existingDayofTotalCents?: number
 *   existingDepositCents?: number  — use as-is instead of recalculating
 * }
 *
 * Response (200):
 * {
 *   giftCardId:       string | null   — null for $0 bookings
 *   giftCardGan:      string | null
 *   depositPaymentId: string | null
 *   dayofOrderId:     string
 *   depositPaidCents: number
 *   dayofTotalCents:  number
 *   remainingCents:   number
 * }
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** Location → county sales-tax catalog object ID */
const LOCATION_TAX: Record<string, string> = {
  TXBSQN0FEKQ11: "UBPQTR3W6ZKVRYFC7DXN2SJN", // Lee County   — 6.5%
  PPTR5G2N0QXF7: "BQNVIEEZQO2PX2FI72U6FEC4", // Collier Co.  — 6.0%
};

const FRIENDLY_PAYMENT_ERRORS: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
  GENERIC_DECLINE: "Card declined. Please try a different card.",
  INVALID_EXPIRATION: "Card expired. Please use a different card.",
  CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
  CARD_EXPIRED: "Card expired. Please use a different card.",
  CARD_DECLINED: "Card declined. Please try a different card.",
  CARD_DECLINED_VERIFICATION_REQUIRED: "Additional verification required. Please try again.",
  VERIFY_AVS_FAILURE: "Address verification failed. Check your billing zip code and try again.",
  ADDRESS_VERIFICATION_FAILURE: "Address verification failed. Check your billing zip code and try again.",
  CARD_TOKEN_USED_BEFORE: "Payment token already used. Please re-enter your card details.",
  CARD_TOKEN_EXPIRED: "Payment session expired. Please re-enter your card details.",
  INVALID_CARD: "Card number could not be validated. Please check and try again.",
  TRANSACTION_LIMIT: "Transaction limit exceeded. Please try a different card.",
  BAD_EXPIRATION: "Card expiration date is invalid. Please check and try again.",
};

interface LineItemInput {
  name: string;
  quantity: string;
  catalogObjectId?: string;
  basePriceMoney: { amount: number; currency: "USD" };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      sourceId: string;
      idempotencyKey?: string;
      locationId: string;
      depositPct?: number;
      lineItems?: LineItemInput[];
      squareCustomerId?: string;
      note?: string;
      /**
       * Pre-created day-of order ID (from /api/square/bowling-orders/quote).
       * When provided, step 1 (creating the day-of order) is skipped.
       * Must be paired with existingDayofTotalCents.
       */
      existingDayofOrderId?: string;
      existingDayofTotalCents?: number;
      /**
       * Pre-computed deposit amount from the quote (cents, tax-inclusive).
       * When provided, used directly instead of recalculating from dayofTotal × depositPct.
       * Ensures the charged amount is identical to what was shown to the customer.
       */
      existingDepositCents?: number;
    };

    const { sourceId, locationId, lineItems, squareCustomerId, note } = body;
    const depositPct = body.depositPct ?? 100;

    if (!sourceId || !locationId) {
      return NextResponse.json({ error: "sourceId and locationId required" }, { status: 400 });
    }
    if (!lineItems?.length && !body.existingDayofOrderId) {
      return NextResponse.json({ error: "lineItems required" }, { status: 400 });
    }
    if (depositPct < 0 || depositPct > 100) {
      return NextResponse.json({ error: "depositPct must be 0–100" }, { status: 400 });
    }

    const baseKey = body.idempotencyKey ?? randomUUID();
    const taxCatalogId = LOCATION_TAX[locationId];
    const orderTaxes = taxCatalogId
      ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
      : [];

    // ── Step 1: Day-of order (full line items + tax, left OPEN) ──────────────
    // When catalogObjectId is present: let Square use the catalog price (Square
    // rejects base_price_money overrides on fixed-price items).
    // When provided via existingDayofOrderId, skip creation entirely.
    let dayofOrderId: string;
    let dayofTotalCents: number;

    if (body.existingDayofOrderId && body.existingDayofTotalCents != null) {
      dayofOrderId = body.existingDayofOrderId;
      dayofTotalCents = body.existingDayofTotalCents;
    } else {
      const dayofLineItems = (lineItems ?? []).map((li) => {
        if (li.catalogObjectId) {
          return { catalog_object_id: li.catalogObjectId, quantity: li.quantity };
        }
        return {
          name: li.name,
          quantity: li.quantity,
          base_price_money: li.basePriceMoney,
        };
      });

      const dayofOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `bowl-dayof-${baseKey}`,
          order: {
            location_id: locationId,
            line_items: dayofLineItems,
            ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
          },
        }),
      });
      const dayofOrderData = await dayofOrderRes.json();

      if (!dayofOrderRes.ok || dayofOrderData.errors) {
        const sqErr = dayofOrderData.errors?.[0];
        const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(dayofOrderData);
        console.error("[square/bowling-orders] day-of order failed:", detail);
        return NextResponse.json({ error: `Failed to create day-of order: ${detail}` }, { status: 500 });
      }

      dayofOrderId = dayofOrderData.order?.id as string;
      if (!dayofOrderId) {
        return NextResponse.json({ error: "Day-of order returned no ID" }, { status: 500 });
      }
      dayofTotalCents = (dayofOrderData.order?.total_money?.amount as number) ?? 0;
    }

    const depositCents =
      body.existingDepositCents != null
        ? body.existingDepositCents
        : Math.round((dayofTotalCents * depositPct) / 100);

    if (depositCents <= 0) {
      // Free booking — no charge, no gift card needed
      return NextResponse.json({
        giftCardId: null,
        giftCardGan: null,
        depositPaymentId: null,
        dayofOrderId,
        depositPaidCents: 0,
        dayofTotalCents,
        remainingCents: dayofTotalCents,
      });
    }

    // ── Step 2: Charge card (standalone payment — no order_id) ───────────────
    // Keeping the charge separate from any order makes refund arithmetic simple:
    // the payment amount is always exactly what the customer owes at cancel time
    // (stored in the gift card balance, step 4).
    //
    // Square Payments idempotency_key max = 45 chars.
    // "pay-" (4) + UUID (36) = 40 — within limit.
    const paymentBody: Record<string, unknown> = {
      source_id: sourceId,
      idempotency_key: `pay-${baseKey}`,
      amount_money: { amount: depositCents, currency: "USD" },
      location_id: locationId,
      autocomplete: true,
      note: note ?? "Bowling deposit",
    };
    if (squareCustomerId) paymentBody.customer_id = squareCustomerId;

    const payRes = await fetch(`${SQUARE_BASE}/payments`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify(paymentBody),
    });
    const payData = await payRes.json();

    if (!payRes.ok || payData.errors) {
      const sqErr = payData.errors?.[0];
      const code: string = sqErr?.code ?? "UNKNOWN";
      const detail: string = sqErr?.detail ?? "Payment failed";
      console.error("[square/bowling-orders] deposit payment failed:", code, detail);
      return NextResponse.json(
        {
          error:
            FRIENDLY_PAYMENT_ERRORS[code] ??
            "Payment could not be processed. Please try again.",
          code,
          detail,
        },
        { status: 400 },
      );
    }

    const depositPaymentId: string = payData.payment?.id;
    if (!depositPaymentId) {
      return NextResponse.json(
        { error: "Payment succeeded but returned no ID" },
        { status: 500 },
      );
    }

    // ── Step 3: Create eGift card ─────────────────────────────────────────────
    const giftCardRes = await fetch(`${SQUARE_BASE}/gift-cards`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gc-${baseKey}`,
        location_id: locationId,
        gift_card: { type: "DIGITAL" },
      }),
    });
    const giftCardData = await giftCardRes.json();

    if (!giftCardRes.ok || giftCardData.errors) {
      const sqErr = giftCardData.errors?.[0];
      const detail = sqErr
        ? `${sqErr.code}: ${sqErr.detail}`
        : JSON.stringify(giftCardData);
      console.error("[square/bowling-orders] gift card creation failed:", detail);
      // Payment already captured — log for reconciliation. The booking is still
      // valid; ops can manually create/link a gift card via the Square dashboard.
      return NextResponse.json(
        { error: `Payment captured but gift card creation failed: ${detail}` },
        { status: 500 },
      );
    }

    const giftCardId: string = giftCardData.gift_card?.id;
    const giftCardGan: string = giftCardData.gift_card?.gan;
    if (!giftCardId || !giftCardGan) {
      return NextResponse.json(
        { error: "Gift card creation returned no ID or GAN" },
        { status: 500 },
      );
    }

    // ── Step 4: Activate the gift card (PENDING → ACTIVE) ────────────────────
    // A freshly-created DIGITAL card is in PENDING state and cannot be loaded
    // until it is activated. Activation does not set a balance — the LOAD step
    // (step 5) sets the balance.
    const activateRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gc-act-${baseKey}`,
        gift_card_activity: {
          type: "ACTIVATE",
          location_id: locationId,
          gift_card_id: giftCardId,
          activate_activity_details: {
            buyer_payment_instrument_ids: [depositPaymentId],
          },
        },
      }),
    });
    const activateData = await activateRes.json();

    if (!activateRes.ok || activateData.errors) {
      const sqErr = activateData.errors?.[0];
      const detail = sqErr
        ? `${sqErr.code}: ${sqErr.detail}`
        : JSON.stringify(activateData);
      console.error("[square/bowling-orders] gift card activation failed:", detail);
      return NextResponse.json(
        { error: `Payment captured but gift card activation failed: ${detail}` },
        { status: 500 },
      );
    }

    // ── Step 5: Load gift card with the exact charged amount ──────────────────
    // balance_money is now the authoritative refund amount — no recalculation
    // needed at cancel time.
    const loadRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gc-load-${baseKey}`,
        gift_card_activity: {
          type: "LOAD",
          location_id: locationId,
          gift_card_id: giftCardId,
          load_activity_details: {
            amount_money: { amount: depositCents, currency: "USD" },
            buyer_payment_instrument_ids: [depositPaymentId],
          },
        },
      }),
    });
    const loadData = await loadRes.json();

    if (!loadRes.ok || loadData.errors) {
      const sqErr = loadData.errors?.[0];
      const detail = sqErr
        ? `${sqErr.code}: ${sqErr.detail}`
        : JSON.stringify(loadData);
      console.error("[square/bowling-orders] gift card load failed:", detail);
      // Card was activated but not loaded. Log for reconciliation.
      return NextResponse.json(
        { error: `Gift card activated but load failed: ${detail}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      giftCardId,
      giftCardGan,
      depositPaymentId,
      dayofOrderId,
      depositPaidCents: depositCents,
      dayofTotalCents,
      remainingCents: dayofTotalCents - depositCents,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[square/bowling-orders] unexpected error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
