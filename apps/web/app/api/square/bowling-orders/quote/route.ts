import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { evaluateCode, getDiscountCodeByCode } from "~/features/discount-codes";

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
 *   locationId    — Square location ID (drives tax catalog lookup)
 *   lineItems     — same shape as bowling-orders lineItems
 *   depositPct    — deposit as % of tax-inclusive total (0–100, default 100)
 *   discountCode  — optional discount code (uppercased). Server re-validates;
 *                   on success the Square order is created with the matching
 *                   catalog discount attached so the returned dayofTotal IS
 *                   the post-discount, tax-inclusive amount.
 *   bookingDate   — YYYY-MM-DD; needed to gate weekday-restricted codes
 *
 * Response:
 *   dayofOrderId        — Square order ID (left open, no payment attached)
 *   dayofTotalCents     — tax-inclusive total from Square (post-discount)
 *   depositCents        — round(dayofTotalCents × depositPct / 100)
 *   appliedDiscount?    — { code, amountOffCents } when a code was attached
 *   discountError?      — string when a sent code was rejected; quote still returns
 *                          without the discount so the customer sees the full price
 *                          rather than a hard failure mid-flow
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
      /** Discount code to apply at the order level. Re-validated server-side. */
      discountCode?: string;
      /** YYYY-MM-DD of the booking — needed for weekday-restricted codes. */
      bookingDate?: string;
    };

    const { locationId, lineItems, depositPct = 100, squareCustomerId } = body;

    if (!locationId || !lineItems?.length) {
      return NextResponse.json({ error: "locationId and lineItems required" }, { status: 400 });
    }

    const taxCatalogId = LOCATION_TAX[locationId];
    const orderTaxes = taxCatalogId
      ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
      : [];

    // ── Re-validate the discount code server-side ─────────────────────────
    // We never trust the client's claim that a code applies. The Square
    // catalog id used here came straight from the DB row, not from the
    // wizard's request body. If the code lost validity since the user
    // typed it (date drifted, code deactivated, weekday wrong) the quote
    // still succeeds — just without the discount — and discountError
    // signals what happened so the UI can prompt a refresh.
    let discountCatalogId: string | null = null;
    let discountError: string | null = null;
    let appliedDiscountSummary: { code: string; amountOffCents: number } | null = null;
    if (body.discountCode) {
      const row = await getDiscountCodeByCode(body.discountCode);
      const evald = evaluateCode(row, {
        code: body.discountCode,
        domain: "bowling",
        locationId,
        bookingDate: body.bookingDate,
      });
      if (evald.valid && evald.squareCatalogId) {
        discountCatalogId = evald.squareCatalogId;
      } else if (evald.valid && !evald.squareCatalogId) {
        // Code is valid in our DB but its Square catalog provisioning never
        // completed. Admin must hit "Retry provision" before customers can use it.
        discountError = "code_not_provisioned";
      } else if (!evald.valid) {
        discountError = evald.reason;
      }
    }

    // Mirror the same line-item building logic as bowling-orders:
    // catalog items → catalog_object_id only; ad-hoc → name + base_price_money
    const dayofLineItems = lineItems.map((li) => {
      const modifiers = li.modifiers?.length
        ? {
            applied_modifiers: li.modifiers.map((m) => ({
              catalog_object_id: m.catalog_object_id,
            })),
          }
        : {};
      const noteField = li.note ? { note: li.note } : {};
      if (li.catalogObjectId) {
        return {
          catalog_object_id: li.catalogObjectId,
          quantity: li.quantity,
          ...modifiers,
          ...noteField,
        };
      }
      return {
        name: li.name,
        quantity: li.quantity,
        base_price_money: li.basePriceMoney,
        ...modifiers,
        ...noteField,
      };
    });

    const orderDiscounts = discountCatalogId
      ? [{ uid: "discount-code", catalog_object_id: discountCatalogId, scope: "ORDER" }]
      : [];

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
          ...(orderDiscounts.length > 0 ? { discounts: orderDiscounts } : {}),
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

    // For UI display only — pull the order-level discount amount Square calculated.
    if (discountCatalogId) {
      const totalDiscountCents = Number(orderData.order?.total_discount_money?.amount ?? 0);
      appliedDiscountSummary = {
        code: body.discountCode!.toUpperCase(),
        amountOffCents: totalDiscountCents,
      };
    }

    return NextResponse.json({
      dayofOrderId,
      dayofTotalCents,
      depositCents,
      ...(appliedDiscountSummary ? { appliedDiscount: appliedDiscountSummary } : {}),
      ...(discountError ? { discountError } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
