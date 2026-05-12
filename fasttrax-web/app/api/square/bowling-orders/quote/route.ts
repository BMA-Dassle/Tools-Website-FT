import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

/**
 * POST /api/square/bowling-orders/quote
 *
 * Creates a Square day-of order (no payment taken) and returns the
 * tax-inclusive total + computed deposit amount.
 *
 * Used by the booking review step so the UI can show the exact amount
 * Square will charge (including county sales tax) before the customer
 * enters their card.  The returned dayofOrderId is passed to
 * /api/bowling/v2/reserve → /api/square/bowling-orders as
 * existingDayofOrderId, so the order is not re-created at submit time.
 *
 * Body:
 *   locationId   — Square location ID (drives tax catalog lookup)
 *   lineItems    — same shape as bowling-orders lineItems
 *   depositPct   — deposit as % of tax-inclusive total (0–100, default 100)
 *
 * Response:
 *   dayofOrderId     — Square order ID (left open, no payment attached)
 *   dayofTotalCents  — tax-inclusive total from Square
 *   depositCents     — round(dayofTotalCents × depositPct / 100)
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

const LOCATION_TAX: Record<string, string> = {
  TXBSQN0FEKQ11: "UBPQTR3W6ZKVRYFC7DXN2SJN", // Lee County   6.5%
  PPTR5G2N0QXF7: "BQNVIEEZQO2PX2FI72U6FEC4", // Collier Co.  6.0%
};

interface LineItemInput {
  name: string;
  quantity: string;
  catalogObjectId?: string;
  basePriceMoney?: { amount: number; currency: "USD" };
  note?: string;
  modifiers?: Array<{ catalog_object_id: string }>;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      locationId: string;
      lineItems: LineItemInput[];
      depositPct?: number;
      /** Loyalty customer ID — attached to the order at creation time for point accrual. */
      squareCustomerId?: string;
    };

    const { locationId, lineItems, depositPct = 100, squareCustomerId } = body;

    if (!locationId || !lineItems?.length) {
      return NextResponse.json(
        { error: "locationId and lineItems required" },
        { status: 400 },
      );
    }

    const taxCatalogId = LOCATION_TAX[locationId];
    const orderTaxes = taxCatalogId
      ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
      : [];

    // Mirror the same line-item building logic as bowling-orders:
    // catalog items → catalog_object_id only; ad-hoc → name + base_price_money
    const dayofLineItems = lineItems.map((li) => {
      const modifiers =
        li.modifiers?.length
          ? { applied_modifiers: li.modifiers.map((m) => ({ catalog_object_id: m.catalog_object_id })) }
          : {};
      const noteField = li.note ? { note: li.note } : {};
      if (li.catalogObjectId) {
        return { catalog_object_id: li.catalogObjectId, quantity: li.quantity, ...modifiers, ...noteField };
      }
      return {
        name: li.name,
        quantity: li.quantity,
        base_price_money: li.basePriceMoney,
        ...modifiers,
        ...noteField,
      };
    });

    const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `bowl-quote-${randomUUID()}`,
        order: {
          location_id: locationId,
          ...(squareCustomerId ? { customer_id: squareCustomerId } : {}),
          line_items: dayofLineItems,
          ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
        },
      }),
    });

    const orderData = await orderRes.json();
    if (!orderRes.ok || orderData.errors) {
      const sqErr = orderData.errors?.[0];
      const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(orderData);
      console.error("[square/bowling-orders/quote] Square order failed:", detail);
      return NextResponse.json({ error: `Square order failed: ${detail}` }, { status: 500 });
    }

    const dayofOrderId: string = orderData.order?.id;
    const dayofTotalCents: number = orderData.order?.total_money?.amount ?? 0;
    const depositCents = Math.round((dayofTotalCents * depositPct) / 100);

    return NextResponse.json({ dayofOrderId, dayofTotalCents, depositCents });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
