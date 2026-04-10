import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_LOCATION = process.env.SQUARE_LOCATION_ID || "";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    "Authorization": `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/**
 * Process a payment using a tokenized card nonce or saved card ID.
 *
 * POST body: {
 *   token: string,           // From card.tokenize() — OR savedCardId
 *   useSavedCard: boolean,
 *   savedCardId?: string,
 *   amount: number,          // Dollar amount (e.g. 49.99)
 *   billId: string,
 *   itemName: string,        // Line item description
 *   contact: { firstName, lastName, email, phone },
 *   saveCard: boolean,
 *   squareCustomerId?: string,
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      token,
      useSavedCard,
      savedCardId,
      amount,
      billId,
      itemName,
      contact,
      saveCard,
      squareCustomerId,
    } = body;

    if (!amount || !billId) {
      return NextResponse.json({ error: "amount and billId required" }, { status: 400 });
    }

    const sourceId = useSavedCard && savedCardId ? savedCardId : token;
    if (!sourceId) {
      return NextResponse.json({ error: "token or savedCardId required" }, { status: 400 });
    }

    const idempotencyKey = randomUUID();
    const amountCents = Math.round(amount * 100);

    // Step 1: Create Square order
    const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `order-${idempotencyKey}`,
        order: {
          location_id: SQUARE_LOCATION,
          line_items: [{
            name: "Deposit",
            quantity: "1",
            base_price_money: { amount: amountCents, currency: "USD" },
          }],
        },
      }),
    });
    const orderData = await orderRes.json();

    if (!orderRes.ok || orderData.errors) {
      console.error("[square/pay] order creation failed:", orderData.errors || orderData);
      return NextResponse.json({ error: "Failed to create order" }, { status: 500 });
    }

    const squareOrderId = orderData.order?.id;

    // Step 2: Process payment
    const paymentBody: Record<string, unknown> = {
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: { amount: amountCents, currency: "USD" },
      order_id: squareOrderId,
      location_id: SQUARE_LOCATION,
      autocomplete: true,
      note: `FastTrax - ${itemName || "Booking"} | Ref: ${billId}`,
    };

    if (contact?.email) paymentBody.buyer_email_address = contact.email;
    if (squareCustomerId) paymentBody.customer_id = squareCustomerId;

    const payRes = await fetch(`${SQUARE_BASE}/payments`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify(paymentBody),
    });
    const payData = await payRes.json();

    if (!payRes.ok || payData.errors) {
      const sqError = payData.errors?.[0];
      const code = sqError?.code || "UNKNOWN";
      const detail = sqError?.detail || "Payment failed";
      console.error("[square/pay] payment failed:", code, detail);

      // Map Square error codes to user-friendly messages
      const messages: Record<string, string> = {
        INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
        GENERIC_DECLINE: "Card declined. Please try a different card.",
        INVALID_EXPIRATION: "Card expired. Please use a different card.",
        CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
        CARD_EXPIRED: "Card expired. Please use a different card.",
        CARD_DECLINED: "Card declined. Please try a different card.",
        CARD_DECLINED_VERIFICATION_REQUIRED: "Additional verification required. Please try again.",
      };

      return NextResponse.json({
        error: messages[code] || "Payment could not be processed. Please try again.",
        code,
        detail,
      }, { status: 400 });
    }

    const payment = payData.payment;
    const cardDetails = payment?.card_details;

    // Step 3: Save card on file (if requested + customer exists)
    let savedNewCardId: string | null = null;
    if (saveCard && squareCustomerId && !useSavedCard && token) {
      try {
        const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `card-${idempotencyKey}`,
            source_id: token,
            card: {
              customer_id: squareCustomerId,
            },
          }),
        });
        const cardData = await cardRes.json();
        if (cardData.card) {
          savedNewCardId = cardData.card.id;
          console.log("[square/pay] card saved:", savedNewCardId);
        }
      } catch {
        console.warn("[square/pay] card save failed (non-fatal)");
      }
    }

    return NextResponse.json({
      success: true,
      paymentId: payment?.id,
      orderId: squareOrderId,
      receiptUrl: payment?.receipt_url || null,
      cardBrand: cardDetails?.card?.card_brand || null,
      cardLast4: cardDetails?.card?.last_4 || null,
      amount,
      savedCardId: savedNewCardId,
    });
  } catch (err) {
    console.error("[square/pay] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Payment error" },
      { status: 500 },
    );
  }
}
