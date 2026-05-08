import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

/**
 * POST /api/square/bowling-orders
 *
 * Creates two Square orders for a bowling booking:
 *
 * 1. Day-of order   — full line items at catalog price + county sales tax,
 *                     left OPEN. Redeemed by staff at center when lanes open.
 *
 * 2. Deposit order  — single "Bowling Deposit" line item for depositCents,
 *                     charged immediately (autocomplete: true). NO tax on the
 *                     deposit order — tax is already baked into the deposit
 *                     amount via the day-of order total.
 *
 * Tax:
 *   The day-of order total (tax-inclusive) is returned by Square after step 1.
 *   depositCents = round(dayofTotal × depositPct / 100)
 *   This ensures the deposit proportionally includes county sales tax.
 *
 *   Location → tax catalog object:
 *     TXBSQN0FEKQ11 (HeadPinz Fort Myers)  → Lee County  6.5%
 *     PPTR5G2N0QXF7 (HeadPinz Naples)      → Collier Co. 6.0%
 *
 * Request body:
 * {
 *   sourceId:        string   — Square nonce from Web Payments SDK
 *   idempotencyKey:  string   — caller-supplied UUID for dedup
 *   locationId:      string   — Square location ID (drives tax selection)
 *   depositPct:      number   — deposit as % of tax-inclusive total (0–100)
 *   lineItems:       Array<{
 *     name:              string
 *     quantity:          string   — "1", "2", …
 *     catalogObjectId?:  string   — Square catalog item variation ID
 *     basePriceMoney:    { amount: number; currency: "USD" }
 *   }>
 *   squareCustomerId?: string — attach buyer to a saved customer
 *   note?:           string
 * }
 *
 * Response (200):
 * {
 *   depositOrderId:   string
 *   depositPaymentId: string
 *   dayofOrderId:     string
 *   depositPaidCents: number   — actual amount charged (tax-inclusive deposit)
 *   dayofTotalCents:  number   — tax-inclusive day-of order total
 *   remainingCents:   number   — dayofTotalCents − depositPaidCents
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
      /** Deposit as % of the tax-inclusive day-of order total. Default 100. */
      depositPct?: number;
      lineItems: LineItemInput[];
      squareCustomerId?: string;
      note?: string;
    };

    const {
      sourceId,
      locationId,
      lineItems,
      squareCustomerId,
      note,
    } = body;

    const depositPct = body.depositPct ?? 100;

    if (!sourceId || !locationId) {
      return NextResponse.json({ error: "sourceId and locationId required" }, { status: 400 });
    }
    if (!lineItems?.length) {
      return NextResponse.json({ error: "lineItems required" }, { status: 400 });
    }
    if (depositPct < 0 || depositPct > 100) {
      return NextResponse.json({ error: "depositPct must be 0–100" }, { status: 400 });
    }

    const baseKey = body.idempotencyKey ?? randomUUID();

    // ── Tax for this location ──────────────────────────────────────
    const taxCatalogId = LOCATION_TAX[locationId];
    const orderTaxes = taxCatalogId
      ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
      : [];

    // ─────────────────────────────────────────────────────────────────
    // Step 1: Create the day-of order (full line items + tax, left OPEN)
    // ─────────────────────────────────────────────────────────────────
    // Build day-of line items.
    // When catalogObjectId is present: let Square use the catalog price (Square
    // rejects base_price_money overrides on fixed-price items). The catalog price
    // is the authoritative amount and the tax will be correctly applied by location.
    // When there is no catalogObjectId: use base_price_money as an ad-hoc line.
    const dayofLineItems = lineItems.map((li) => {
      if (li.catalogObjectId) {
        return {
          catalog_object_id: li.catalogObjectId,
          quantity: li.quantity,
        };
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
          // No payment — order stays OPEN for staff to close at center
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

    const dayofOrderId: string = dayofOrderData.order?.id;
    if (!dayofOrderId) {
      return NextResponse.json({ error: "Day-of order returned no ID" }, { status: 500 });
    }

    // Tax-inclusive total from Square — use this as the authoritative order value
    const dayofTotalCents: number = dayofOrderData.order?.total_money?.amount ?? 0;

    // Deposit is a percentage of the tax-inclusive total
    const depositCents = Math.round(dayofTotalCents * depositPct / 100);

    if (depositCents <= 0) {
      // Nothing to charge — return without creating deposit order
      return NextResponse.json({
        depositOrderId: null,
        depositPaymentId: null,
        dayofOrderId,
        depositPaidCents: 0,
        dayofTotalCents,
        remainingCents: dayofTotalCents,
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // Step 2: Create the deposit order (single line item, no tax)
    //   The depositCents already proportionally includes tax because it
    //   was derived from the tax-inclusive day-of order total.
    // ─────────────────────────────────────────────────────────────────
    const depositOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `bowl-dep-order-${baseKey}`,
        order: {
          location_id: locationId,
          line_items: [
            {
              name: "Bowling Deposit",
              quantity: "1",
              base_price_money: { amount: depositCents, currency: "USD" },
            },
          ],
        },
      }),
    });
    const depositOrderData = await depositOrderRes.json();

    if (!depositOrderRes.ok || depositOrderData.errors) {
      const sqErr = depositOrderData.errors?.[0];
      const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(depositOrderData);
      console.error("[square/bowling-orders] deposit order failed:", detail);
      return NextResponse.json({ error: `Failed to create deposit order: ${detail}` }, { status: 500 });
    }

    const depositOrderId: string = depositOrderData.order?.id;
    if (!depositOrderId) {
      return NextResponse.json({ error: "Deposit order returned no ID" }, { status: 500 });
    }

    // ─────────────────────────────────────────────────────────────────
    // Step 3: Charge the deposit (autocomplete: true — immediate)
    // ─────────────────────────────────────────────────────────────────
    const paymentBody: Record<string, unknown> = {
      source_id: sourceId,
      idempotency_key: `bowl-dep-pay-${baseKey}`,
      amount_money: { amount: depositCents, currency: "USD" },
      order_id: depositOrderId,
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

      const friendlyMessages: Record<string, string> = {
        INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
        GENERIC_DECLINE: "Card declined. Please try a different card.",
        INVALID_EXPIRATION: "Card expired. Please use a different card.",
        CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
        CARD_EXPIRED: "Card expired. Please use a different card.",
        CARD_DECLINED: "Card declined. Please try a different card.",
        CARD_DECLINED_VERIFICATION_REQUIRED:
          "Additional verification required. Please try again.",
      };

      return NextResponse.json(
        {
          error: friendlyMessages[code] ?? "Payment could not be processed. Please try again.",
          code,
          detail,
        },
        { status: 400 },
      );
    }

    const depositPaymentId: string = payData.payment?.id;

    return NextResponse.json({
      depositOrderId,
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
