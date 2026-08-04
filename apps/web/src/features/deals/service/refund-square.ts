/**
 * The Square calls a deal refund makes that no existing helper covers.
 *
 * Everything else is reused: `createReturnOrder` and `refundTenderPartial` from
 * `reservation-edit/square-actions` (their `editId` parameter is only a key
 * namespace, so a deal refund key is a correct thing to pass), `fetchOrderFacts`
 * and `fetchPaymentFacts` from `cancellation/square-actions`, and
 * `createDigitalGiftCard` from `lib/square-gift-card`.
 *
 * What is NOT reusable is the cross-tender refund below, which exists nowhere
 * else in the codebase.
 */

import { sq } from "~/features/cancellation/square-actions";

/**
 * Move money from a card charge onto a gift card, in one Square call.
 *
 * PROBED LIVE 2026-07-28. Three findings are baked into this request shape and
 * every one of them is load-bearing:
 *
 *   1. A LINKED refund (`payment_id` present) with a `destination_id` pointing
 *      somewhere other than the original tender DOES move money — the gift card
 *      credited in about ten seconds and the refund COMPLETED.
 *   2. Adding `order_id` KILLS IT. The request is accepted, the refund sits at
 *      PENDING forever, and the credit never reaches the card. That was the T2
 *      arm, re-confirmed by `crosstender-t2-reconcile.mts` after an initial
 *      false positive.
 *   3. `location_id` on a linked refund is rejected outright with
 *      CONFLICTING_PARAMETERS.
 *
 * Finding 2 is why this refund is NOT itemized, in a codebase whose standing
 * rule is that refunds must always be itemized. The two are mutually exclusive
 * in Square's API: you can have the item-level reporting or you can have the
 * gift-card credit, not both. The owner chose the credit. The plan surfaces that
 * trade-off to staff as a warning rather than hiding it here.
 *
 * Do not "tidy" this by adding an order id.
 */
export async function refundToGiftCard(params: {
  /** Idempotency key. Replaying it returns the ORIGINAL refund, never a second. */
  idempotencyKey: string;
  paymentId: string;
  /** Square gift card id (not the GAN) to credit. */
  destinationGiftCardId: string;
  amountCents: number;
  reason: string;
}): Promise<{ refundId: string; status: string }> {
  const res = await sq("POST", "/refunds", {
    idempotency_key: params.idempotencyKey,
    payment_id: params.paymentId,
    amount_money: { amount: params.amountCents, currency: "USD" },
    destination_id: params.destinationGiftCardId,
    reason: params.reason,
    // NO order_id   — see finding 2. An order-linked cross-tender refund is
    //                 accepted, stays PENDING forever, and never credits.
    // NO location_id — see finding 3. A linked refund rejects it.
  });
  if (!res.ok || !res.json?.refund?.id) {
    const detail = res.json?.errors?.[0]?.detail ?? `status ${res.status}`;
    throw new Error(`cross-tender refund of ${params.paymentId} failed: ${detail}`);
  }
  return {
    refundId: String(res.json.refund.id),
    // Usually PENDING at this point. Square settles gift-card credits in batch,
    // so status lags the money — poll the CARD BALANCE, not this.
    status: String(res.json.refund.status ?? "PENDING"),
  };
}

/** Live balance on a gift card, for confirming a credit actually landed. */
export async function giftCardBalanceCents(giftCardId: string): Promise<number | null> {
  const res = await sq("GET", `/gift-cards/${giftCardId}`);
  if (!res.ok || !res.json?.gift_card) return null;
  return Number(res.json.gift_card.balance_money?.amount ?? 0);
}
