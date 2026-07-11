import { squareErrorDetail, squareFetch } from "./square-client";

export interface SaveCardResult {
  ok: boolean;
  cardId?: string;
  brand?: string;
  last4?: string;
  error?: string;
}

/**
 * Save a card on file. Cards are customer-scoped (no location needed). We
 * CreateCard directly — the same proven path as the Have-A-Ball subscription
 * flow (app/api/square/subscription/route.ts `saveCardToCustomer`). We
 * deliberately do NOT run a separate $0 verification payment first: that
 * would consume a single-use token before CreateCard could use it. CreateCard
 * validates the card itself; `verification_token` carries 3DS/SCA when present.
 *
 * `cardToken` accepts either supported CreateCard source kind:
 *  - a Web Payments SDK single-use token (`cnon:…`) — the account portal's
 *    explicit "save my card" flow;
 *  - a captured Square *payment id* — the card-vault silent capture at
 *    booking (the nonce was already spent on the deposit charge; Square
 *    vaults the card the payment was made with). Never re-use a nonce across
 *    two Square calls (lesson 2026-06-18).
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

export interface DisableCardResult {
  ok: boolean;
  /** True when Square reported the card was already disabled — treated as
   *  success so the card-vault sweep's retries stay idempotent. */
  alreadyDisabled?: boolean;
  error?: string;
}

/** Square error signatures for "this card is already disabled". */
function isAlreadyDisabledError(data: unknown): boolean {
  const errs = (data as { errors?: { code?: string; detail?: string }[] })?.errors;
  if (!Array.isArray(errs)) return false;
  return errs.some(
    (e) =>
      e.code === "CARD_DISABLED" ||
      e.code === "GIFT_CARD_DISABLED" ||
      /already\s+disabled/i.test(e.detail ?? "") ||
      /card\s+is\s+disabled/i.test(e.detail ?? ""),
  );
}

/**
 * Disable a card on file — `POST /v2/cards/{id}/disable`. Square has no
 * DeleteCard; disabled cards stop appearing in `fetchSavedCards` (it filters
 * `enabled === false`) and can't be charged. Already-disabled-class errors
 * map to `{ ok: true, alreadyDisabled: true }` so replays are no-ops.
 */
export async function disableCard(cardId: string): Promise<DisableCardResult> {
  const { ok, data } = await squareFetch<{ card?: { id?: string; enabled?: boolean } }>(
    `/cards/${encodeURIComponent(cardId)}/disable`,
    { method: "POST" },
  );
  if (ok) {
    return { ok: true };
  }
  if (isAlreadyDisabledError(data)) {
    return { ok: true, alreadyDisabled: true };
  }
  return { ok: false, error: squareErrorDetail(data) };
}
