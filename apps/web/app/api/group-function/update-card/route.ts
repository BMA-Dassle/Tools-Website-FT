import { NextRequest, NextResponse } from "next/server";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import { sql } from "@/lib/db";

/**
 * POST /api/group-function/update-card
 *
 * Update the saved card on file for a group function contract.
 * Called from the event page when the customer wants to change
 * the card that will be auto-charged for the balance.
 *
 * Body: { contractShortId, cardSourceId }
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

export async function POST(req: NextRequest) {
  const { contractShortId, cardSourceId } = (await req.json()) as {
    contractShortId: string;
    cardSourceId: string;
  };

  if (!contractShortId || !cardSourceId) {
    return NextResponse.json(
      { error: "contractShortId and cardSourceId required" },
      { status: 400 },
    );
  }

  const quote = await getGfQuoteByShortId(contractShortId);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  if (!quote.square_customer_id) {
    return NextResponse.json({ error: "No customer on file" }, { status: 400 });
  }

  // Tokenize the new card via Square (charge $0 to verify, then save)
  try {
    // Verify the card with a $0 auth
    const verifyRes = await fetch(`${SQUARE_BASE}/payments`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-verify-${contractShortId}-${Date.now()}`,
        source_id: cardSourceId,
        amount_money: { amount: 0, currency: "USD" },
        location_id: quote.square_location_id,
        autocomplete: false,
        verify_buyer_address_against: "POSTAL_CODE",
      }),
    });
    const verifyData = await verifyRes.json();

    // Save the card using the payment ID
    const paymentId = verifyData.payment?.id;
    if (!paymentId) {
      const errMsg = verifyData.errors?.[0]?.detail || "Card verification failed";
      return NextResponse.json({ error: errMsg }, { status: 400 });
    }

    // Cancel the $0 auth
    await fetch(`${SQUARE_BASE}/payments/${paymentId}/cancel`, {
      method: "POST",
      headers: sqHeaders(),
    });

    // Save the new card
    const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-update-card-${contractShortId}-${Date.now()}`,
        source_id: cardSourceId,
        card: { customer_id: quote.square_customer_id },
      }),
    });
    const cardData = await cardRes.json();

    if (!cardRes.ok || !cardData.card?.id) {
      const errMsg = cardData.errors?.[0]?.detail || "Failed to save card";
      return NextResponse.json({ error: errMsg }, { status: 400 });
    }

    const newCardId = cardData.card.id;
    const last4 = cardData.card.last_4 || "";
    const brand = cardData.card.card_brand || "";

    // Update the quote with the new card + display info
    const q = sql();
    await q`UPDATE group_function_quotes SET
      saved_card_id = ${newCardId},
      saved_card_last4 = ${last4},
      saved_card_brand = ${brand},
      updated_at = NOW()
    WHERE id = ${quote.id}`;

    console.log(
      `[update-card] quote=${quote.id} card updated to ${newCardId} (${brand} ...${last4})`,
    );

    return NextResponse.json({ ok: true, last4, brand });
  } catch (err) {
    console.error("[update-card] error:", err);
    return NextResponse.json({ error: "Failed to update card" }, { status: 500 });
  }
}
