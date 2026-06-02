import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import { sql } from "@/lib/db";
import { buildSquareLineItem } from "@/lib/plu-catalog-map";

/**
 * POST /api/admin/group-functions/backfill-dayof
 *
 * Creates a missing Square day-of order for a group function quote
 * and saves the order ID to the DB. Used when the day-of order
 * creation failed silently during the deposit flow.
 *
 * Body: { shortId, token }
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";
const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { shortId, token } = body as { shortId: string; token: string };

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!shortId) {
    return NextResponse.json({ error: "shortId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  if (quote.square_dayof_order_id) {
    return NextResponse.json({
      ok: true,
      action: "already_exists",
      dayofOrderId: quote.square_dayof_order_id,
    });
  }

  const rawItems = quote.line_items as Array<{
    name: string;
    price: number;
    tax: number;
    qty: number;
    total: number;
    plu: string;
  }>;

  const serviceCharges =
    quote.tax_cents > 0
      ? [
          {
            name: "Service Charge",
            amount_money: { amount: quote.tax_cents, currency: "USD" },
            calculation_phase: "SUBTOTAL_PHASE",
          },
        ]
      : [];

  const baseKey = randomBytes(8).toString("hex");
  const refId = `GF-${quote.event_number || quote.bmi_reservation_id}`.slice(0, 40);

  // Try catalog-linked first, then ad-hoc fallback
  let dayofOrderId: string | undefined;

  try {
    const lineItems = rawItems.map((p) => buildSquareLineItem(quote.center_code, p));
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-backfill-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: refId,
          line_items: lineItems,
          service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
        },
      }),
    });
    const data = await res.json();
    if (res.ok && data.order?.id) {
      dayofOrderId = data.order.id;
    } else {
      console.warn("[backfill-dayof] catalog order failed, trying ad-hoc:", data);
    }
  } catch (err) {
    console.warn("[backfill-dayof] catalog order error:", err);
  }

  if (!dayofOrderId) {
    const adHocItems = rawItems.map((p) => ({
      name: p.name,
      quantity: String(p.qty),
      base_price_money: { amount: Math.round(p.price * 100), currency: "USD" },
    }));
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-backfill-adhoc-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: refId,
          line_items: adHocItems,
          service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
        },
      }),
    });
    const data = await res.json();
    if (res.ok && data.order?.id) {
      dayofOrderId = data.order.id;
    } else {
      return NextResponse.json(
        { error: "Failed to create day-of order", details: data },
        { status: 500 },
      );
    }
  }

  const q = sql();
  await q`
    UPDATE group_function_quotes
    SET square_dayof_order_id = ${dayofOrderId},
        updated_at = NOW()
    WHERE id = ${quote.id}
  `;

  console.log(`[backfill-dayof] created day-of order ${dayofOrderId} for quote ${quote.id}`);

  return NextResponse.json({
    ok: true,
    action: "created",
    dayofOrderId,
    quoteId: quote.id,
  });
}
