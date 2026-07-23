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
  const { contractShortId, cardSourceId, verificationToken } = (await req.json()) as {
    contractShortId: string;
    cardSourceId: string;
    verificationToken?: string;
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

  // Create a Square customer on the fly if the quote doesn't have one yet — e.g. a
  // legacy win-back guest adding their first card. Persisted with the card below.
  let customerId = quote.square_customer_id;
  if (!customerId) {
    try {
      const { findOrCreateSquareCustomer } = await import("@/lib/square-gift-card");
      customerId = await findOrCreateSquareCustomer(quote);
    } catch (err) {
      console.error("[update-card] customer create failed:", err);
    }
    if (!customerId) {
      return NextResponse.json({ error: "Could not create a customer on file" }, { status: 500 });
    }
  }

  // Save the card on file directly from the Web Payments SDK card token.
  //
  // We do NOT pre-charge a $0 "verification" payment first: Square rejects
  // CreatePayment with amount_money.amount = 0 for a card source, so that step
  // always failed (verifyData.payment?.id undefined → 400 "Card verification
  // failed") and the route never reached CreateCard. CreateCard accepts the
  // single-use card nonce as source_id directly — no charge needed to save it.
  // (An optional client-supplied verificationToken from payments.verifyBuyer()
  // is forwarded when present, for accounts/cards that require SCA/3DS.)
  try {
    const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-update-card-${contractShortId}-${Date.now()}`,
        source_id: cardSourceId,
        ...(verificationToken ? { verification_token: verificationToken } : {}),
        card: { customer_id: customerId },
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
      square_customer_id = ${customerId},
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
