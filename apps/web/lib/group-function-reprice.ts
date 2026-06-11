import {
  loadBalanceOntoGiftCards,
  findOrCreateSquareCustomer,
  SquarePaymentError,
} from "@/lib/square-gift-card";
import {
  parseGiftCardIds,
  parseGiftCardGans,
  updateGfGiftCardList,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";

/**
 * Charge a re-price delta and fund the day-of gift cards.
 *
 * Used by /api/group-function/resign-settle when a PAID-IN-FULL group event is
 * re-priced UP and the guest re-signs: we collect only the difference (not the
 * whole new balance) and LOAD it onto the existing day-of gift cards so the
 * day-of payout stays fully funded.
 *
 *  - card on file  → `sourceId` = saved_card_id, `saveNewCard` = false
 *  - card captured → `sourceId` = a Web Payments nonce, `saveNewCard` = true
 *    (the card is saved on file after the charge for future adjustments)
 *
 * Throws SquarePaymentError on a declined/failed charge (caller maps to 402).
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

export interface RepriceChargeResult {
  orderId: string;
  paymentId: string;
  squareCustomerId?: string;
  savedCardId?: string;
  savedCardLast4?: string;
  savedCardBrand?: string;
}

export async function chargeDeltaAndLoad(params: {
  quote: GroupFunctionQuote;
  deltaCents: number;
  sourceId: string;
  saveNewCard: boolean;
  baseKey: string;
}): Promise<RepriceChargeResult> {
  const { quote, deltaCents, sourceId, saveNewCard, baseKey } = params;

  if (deltaCents <= 0) {
    throw new SquarePaymentError("INVALID_AMOUNT", "Re-price delta must be greater than zero");
  }

  // Resolve the Square customer (needed to attach the payment + save the card).
  let squareCustomerId = quote.square_customer_id ?? undefined;
  if (!squareCustomerId && saveNewCard) {
    squareCustomerId = (await findOrCreateSquareCustomer(quote)) ?? undefined;
  }

  // 1. Order for the delta.
  const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gf-reprice-order-${baseKey}`,
      order: {
        location_id: quote.square_location_id,
        reference_id: `GF Adjustment: ${quote.event_number || ""}`.slice(0, 40),
        line_items: [
          {
            name: "Group Event Adjustment",
            quantity: "1",
            base_price_money: { amount: deltaCents, currency: "USD" },
          },
        ],
      },
    }),
  });
  const orderData = await orderRes.json();
  if (!orderRes.ok || !orderData.order?.id) {
    throw new SquarePaymentError(
      orderData.errors?.[0]?.code || "REPRICE_ORDER_FAILED",
      orderData.errors?.[0]?.detail || `status ${orderRes.status}`,
      orderRes.status,
    );
  }
  const orderId = orderData.order.id as string;

  // 2. Charge the source (saved card or nonce).
  const payRes = await fetch(`${SQUARE_BASE}/payments`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gf-reprice-pay-${baseKey}`,
      source_id: sourceId,
      amount_money: { amount: deltaCents, currency: "USD" },
      order_id: orderId,
      location_id: quote.square_location_id,
      ...(squareCustomerId ? { customer_id: squareCustomerId } : {}),
      autocomplete: true,
      note: `GF Adjustment: ${quote.event_name || ""} (${quote.event_number || ""})`,
    }),
  });
  const payData = await payRes.json();
  if (!payRes.ok || payData.errors) {
    throw new SquarePaymentError(
      payData.errors?.[0]?.code || "REPRICE_CHARGE_FAILED",
      payData.errors?.[0]?.detail || "The card could not be charged.",
      payRes.status,
    );
  }
  const paymentId = payData.payment?.id as string;

  // 3. LOAD the delta onto the existing day-of gift cards ($2k chunk; overflow → new cards).
  const loaded = await loadBalanceOntoGiftCards({
    giftCardIds: parseGiftCardIds(quote.square_gift_card_id),
    locationId: quote.square_location_id,
    amountCents: deltaCents,
    baseKey,
    buyerPaymentInstrumentIds: paymentId ? [paymentId] : [],
  });
  if (loaded.createdCards.length) {
    await updateGfGiftCardList(quote.id, {
      giftCardIds: loaded.giftCardIds,
      giftCardGans: [
        ...parseGiftCardGans(quote.square_gift_card_gan),
        ...loaded.createdCards.map((c) => c.gan ?? ""),
      ],
    });
  }

  // 4. Save the card on file (new-card path) so future adjustments can auto-charge.
  let savedCardId: string | undefined;
  let savedCardLast4: string | undefined;
  let savedCardBrand: string | undefined;
  if (saveNewCard && squareCustomerId) {
    const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-reprice-card-${baseKey}`,
        source_id: paymentId,
        card: { customer_id: squareCustomerId },
      }),
    });
    const cardData = await cardRes.json();
    if (cardRes.ok && cardData.card?.id) {
      savedCardId = cardData.card.id;
      savedCardLast4 = cardData.card.last_4 || undefined;
      savedCardBrand = cardData.card.card_brand || undefined;
    } else {
      console.error("[gf-reprice] card save failed:", JSON.stringify(cardData).slice(0, 400));
    }
  }

  return { orderId, paymentId, squareCustomerId, savedCardId, savedCardLast4, savedCardBrand };
}
