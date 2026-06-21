import { squareErrorDetail, squareFetch } from "./square-client";

export interface SaveCardResult {
  ok: boolean;
  cardId?: string;
  brand?: string;
  last4?: string;
  error?: string;
}

/**
 * Save a card on file from a Web Payments SDK token. Cards are customer-scoped
 * (no location needed). We CreateCard directly with the single-use token —
 * the same proven path as the Have-A-Ball subscription flow
 * (app/api/square/subscription/route.ts `saveCardToCustomer`). We deliberately
 * do NOT run a separate $0 verification payment first: that would consume the
 * single-use token before CreateCard could use it. CreateCard validates the
 * card itself; `verification_token` carries 3DS/SCA when present.
 */
export async function saveCardOnFile(params: {
  customerId: string;
  cardToken: string;
  verificationToken?: string;
  idempotencyKey: string;
}): Promise<SaveCardResult> {
  const { ok, data } = await squareFetch<{
    card?: { id?: string; card_brand?: string; last_4?: string };
  }>("/cards", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: params.idempotencyKey,
      source_id: params.cardToken,
      verification_token: params.verificationToken || undefined,
      card: { customer_id: params.customerId },
    }),
  });

  const card = data.card;
  if (!ok || !card?.id) {
    return { ok: false, error: squareErrorDetail(data) };
  }
  return { ok: true, cardId: card.id, brand: card.card_brand || "Card", last4: card.last_4 || "" };
}
