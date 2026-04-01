import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION = process.env.SQUARE_LOCATION_ID || "";

/**
 * Create a Square Checkout payment link.
 *
 * POST body: { billId, amount, raceName, returnUrl, cancelUrl }
 *
 * Returns: { checkoutUrl, orderId (Square order ID) }
 */
export async function POST(req: NextRequest) {
  try {
    const { billId, amount, raceName, returnUrl, cancelUrl } = await req.json();

    if (!billId || !amount) {
      return NextResponse.json({ error: "billId and amount required" }, { status: 400 });
    }

    // Create a Square Checkout link via the Payment Links API
    const idempotencyKey = randomUUID();
    const amountCents = Math.round(amount * 100);

    const res = await fetch(`${SQUARE_BASE}/online-checkout/payment-links`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SQUARE_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-12-18",
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: raceName || "FastTrax Race Booking",
          price_money: {
            amount: amountCents,
            currency: "USD",
          },
          location_id: SQUARE_LOCATION,
        },
        checkout_options: {
          redirect_url: returnUrl || undefined,
          ask_for_shipping_address: false,
        },
        pre_populated_data: {
          buyer_email: undefined,
        },
        payment_note: `FastTrax Booking ${billId}`,
      }),
    });

    const data = await res.json();

    if (!res.ok || data.errors) {
      console.error("[Square Checkout Error]", JSON.stringify(data.errors || data));
      return NextResponse.json(
        { error: data.errors?.[0]?.detail || "Failed to create checkout" },
        { status: 500 },
      );
    }

    const link = data.payment_link;
    return NextResponse.json({
      checkoutUrl: link.url,
      squareOrderId: link.order_id,
      paymentLinkId: link.id,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Square checkout error" },
      { status: 500 },
    );
  }
}
