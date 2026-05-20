/**
 * Square gift card + multi-tender helpers.
 *
 * Used by /api/square/pay and /api/square/bowling-orders to support
 * customer-facing Square gift cards as a payment method, including
 * partial coverage where the gift card balance < bill total and the
 * remainder is charged to a card.
 *
 * Architecture (see tasks/future/gift-card-multi-tender-payments.md
 * and the approved plan):
 *
 *  Square rejects `autocomplete: true` combined with
 *  `accept_partial_authorization: true`. So we authorize both tenders
 *  with autocomplete=false, inspect the gift card's approved_money,
 *  then complete or cancel. Auths that get cancelled never settle —
 *  no compensating refund needed.
 *
 * DEPX block: bowling refund-deposit eGift cards (issued by
 * /api/square/bowling-orders with GANs like "HPFMX77012") are an
 * internal staff accounting instrument, NOT a customer payment
 * method. We reject them at the balance lookup AND at every
 * authorize call.
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

export interface GiftCardInfo {
  id: string;
  gan: string;
  balanceCents: number;
  state: string;
  blocked: boolean;
  blockedReason?: "internal" | "inactive" | "zero-balance";
}

/**
 * Match the GAN prefixes used by /api/square/bowling-orders for
 * internal staff-facing deposit eGift cards. Centralized so changes
 * stay in one place if bowling's GAN format ever evolves.
 *
 * Current prefixes (see /api/bowling/v2/reserve CENTER_GAN_PREFIX):
 *   HPFM…  HeadPinz Fort Myers
 *   HPN…   HeadPinz Naples
 *   HP…    Fallback
 *   DEPX…  Older format, still possible in the wild
 */
export function isInternalDepositGan(gan: string | null | undefined): boolean {
  if (!gan) return false;
  return /^(HPFM|HPN|DEPX)/i.test(gan);
}

/**
 * Look up a Square gift card from a Web Payments SDK nonce.
 * Returns balance + GAN + a `blocked` flag when it's an internal
 * deposit GAN or unusable.
 *
 * Square endpoint: POST /v2/gift-cards/from-nonce
 */
export async function retrieveGiftCardFromNonce(nonce: string): Promise<GiftCardInfo | null> {
  const res = await fetch(`${SQUARE_BASE}/gift-cards/from-nonce`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({ nonce }),
  });
  const data = await res.json();
  if (!res.ok || data.errors || !data.gift_card) {
    console.warn("[square-gift-card] from-nonce failed:", data.errors || data);
    return null;
  }
  const gc = data.gift_card;
  const gan: string = gc.gan || "";
  const balanceCents: number = gc.balance_money?.amount ?? 0;
  const state: string = gc.state || "UNKNOWN";

  const blocked = isInternalDepositGan(gan);
  return {
    id: gc.id,
    gan,
    balanceCents,
    state,
    blocked,
    blockedReason: blocked ? "internal" : state !== "ACTIVE" ? "inactive" : undefined,
  };
}

/**
 * Authorize a payment against an order using a Square gift card nonce.
 *
 * IMPORTANT: caller passes the EXACT amount to charge against the GC
 * (i.e. `min(balanceCents, totalCents)`), NOT the order total. This
 * keeps the GC payment's `amount_money` aligned with what Square will
 * actually settle, so the order's payment-total reconciliation works
 * (otherwise: ORDER_TOTAL_MISMATCH on complete).
 *
 * We deliberately do NOT use `accept_partial_authorization` because
 * Square keeps `payment.amount_money` at the requested amount for
 * order-total math even when `approved_money` is lower, breaking
 * multi-tender. Since we already retrieved the GC balance before this
 * call, we can request the exact amount up-front.
 *
 * `autocomplete: false` — the auth is held until `completePayment` or
 * `cancelPayment` lands.
 */
export async function authorizeGiftCardPayment(params: {
  orderId: string;
  locationId: string;
  nonce: string;
  /** Exact cents to charge against the GC (≤ available balance). */
  amountCents: number;
  baseKey: string;
}): Promise<{ paymentId: string; approvedCents: number }> {
  const body = {
    source_id: params.nonce,
    idempotency_key: `pay-gc-${params.baseKey}`,
    amount_money: { amount: params.amountCents, currency: "USD" },
    order_id: params.orderId,
    location_id: params.locationId,
    autocomplete: false,
  };
  const res = await fetch(`${SQUARE_BASE}/payments`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    const e = data.errors?.[0];
    throw new SquarePaymentError(
      e?.code || "GIFT_CARD_AUTH_FAILED",
      e?.detail || "Gift card could not be charged.",
    );
  }
  const paymentId: string = data.payment?.id;
  // With the exact-amount approach, amount_money == approved_money ==
  // total_money. Read amount_money as the canonical settled amount.
  const approvedCents: number =
    data.payment?.amount_money?.amount ?? data.payment?.approved_money?.amount ?? 0;
  if (!paymentId) {
    throw new SquarePaymentError("MISSING_PAYMENT_ID", "Gift card authorize returned no paymentId");
  }
  return { paymentId, approvedCents };
}

/**
 * Authorize a card / wallet payment against an order with
 * `autocomplete: false`. Caller completes or cancels.
 */
export async function authorizeCardPayment(params: {
  orderId: string;
  locationId: string;
  sourceId: string;
  amountCents: number;
  baseKey: string;
  customerId?: string;
  buyerEmail?: string;
  note?: string;
}): Promise<{ paymentId: string }> {
  const body: Record<string, unknown> = {
    source_id: params.sourceId,
    idempotency_key: `pay-card-${params.baseKey}`,
    amount_money: { amount: params.amountCents, currency: "USD" },
    order_id: params.orderId,
    location_id: params.locationId,
    autocomplete: false,
  };
  if (params.customerId) body.customer_id = params.customerId;
  if (params.buyerEmail) body.buyer_email_address = params.buyerEmail;
  if (params.note) body.note = params.note;

  const res = await fetch(`${SQUARE_BASE}/payments`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    const e = data.errors?.[0];
    throw new SquarePaymentError(
      e?.code || "CARD_AUTH_FAILED",
      e?.detail || "Card could not be charged.",
    );
  }
  const paymentId: string = data.payment?.id;
  if (!paymentId) {
    throw new SquarePaymentError("MISSING_PAYMENT_ID", "Card authorize returned no paymentId");
  }
  return { paymentId };
}

export async function completeSquarePayment(
  paymentId: string,
  baseKey: string,
  kind: "gc" | "card",
): Promise<void> {
  const res = await fetch(`${SQUARE_BASE}/payments/${paymentId}/complete`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({ idempotency_key: `comp-${kind}-${baseKey}` }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const e = data.errors?.[0];
    throw new SquarePaymentError(
      e?.code || "COMPLETE_FAILED",
      e?.detail || "Payment completion failed",
    );
  }
}

export async function cancelSquarePayment(
  paymentId: string,
  baseKey: string,
  kind: "gc" | "card",
): Promise<void> {
  // /payments/{id}/cancel with an idempotency key. Errors are logged
  // but not thrown — if cancel itself fails Square auto-voids
  // unsettled auths after ~6 days; we don't want a cancel failure
  // masking the original payment error to the customer.
  try {
    const res = await fetch(`${SQUARE_BASE}/payments/${paymentId}/cancel`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({ idempotency_key: `cancel-${kind}-${baseKey}` }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn(
        `[square-gift-card] cancel-${kind} failed for ${paymentId}:`,
        data.errors || data,
      );
    }
  } catch (err) {
    console.warn(`[square-gift-card] cancel-${kind} threw for ${paymentId}:`, err);
  }
}

export interface MultiTenderResult {
  /** Square paymentId for the gift card authorization (if used). */
  gcPaymentId?: string;
  /** Square paymentId for the card / wallet authorization (if used). */
  cardPaymentId?: string;
  /** Amount the gift card actually covered (cents). 0 if no GC used. */
  gcApprovedCents: number;
  /** Amount the card / wallet authorized (cents). 0 if no card used. */
  cardApprovedCents: number;
  /** GAN of the redeemed gift card, for UI / sales-log breadcrumbs. */
  gcGan?: string;
}

export class SquarePaymentError extends Error {
  code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.code = code;
  }
}

/**
 * Authorize one or both tenders against `orderId`, then complete
 * both. On any failure, cancels any successful authorization so the
 * customer is never charged.
 *
 * Inputs:
 *   - giftCardNonce: from `payments.giftCard().tokenize()`. Optional.
 *   - cardSourceId: a card nonce, a savedCardId, or a wallet nonce. Optional.
 *
 * Behavior:
 *   - If only giftCardNonce: GC must cover the full total.
 *   - If only cardSourceId: card pays the full total.
 *   - If both: GC authorizes up to balance, card covers the remainder.
 *
 * Throws SquarePaymentError on failure. Customer is never charged on
 * throw.
 */
export async function authorizeMultiTender(params: {
  orderId: string;
  locationId: string;
  totalCents: number;
  baseKey: string;
  giftCardNonce?: string;
  cardSourceId?: string;
  customerId?: string;
  buyerEmail?: string;
  note?: string;
}): Promise<MultiTenderResult> {
  const { orderId, locationId, totalCents, baseKey, giftCardNonce, cardSourceId } = params;

  if (totalCents <= 0) {
    throw new SquarePaymentError("INVALID_AMOUNT", "Amount must be greater than zero");
  }
  if (!giftCardNonce && !cardSourceId) {
    throw new SquarePaymentError("NO_TENDER", "No payment method provided");
  }

  let gcPaymentId: string | undefined;
  let gcApprovedCents = 0;
  let gcGan: string | undefined;

  // ── Step A: Authorize gift card (if provided) ─────────────────────
  if (giftCardNonce) {
    // Server-side DEPX block — the balance endpoint is a UX preview;
    // this is the security boundary.
    const gcInfo = await retrieveGiftCardFromNonce(giftCardNonce);
    if (!gcInfo) {
      throw new SquarePaymentError(
        "GIFT_CARD_NOT_FOUND",
        "Gift card could not be found. Please re-enter the gift card number.",
      );
    }
    if (gcInfo.blocked) {
      throw new SquarePaymentError(
        "GIFT_CARD_BLOCKED",
        "This gift card type cannot be used online.",
      );
    }
    if (gcInfo.state !== "ACTIVE") {
      throw new SquarePaymentError("GIFT_CARD_INACTIVE", "This gift card is not active.");
    }
    if (gcInfo.balanceCents <= 0) {
      throw new SquarePaymentError("GIFT_CARD_EMPTY", "This gift card has no balance available.");
    }
    gcGan = gcInfo.gan;

    // Authorize for the exact amount the GC can cover (capped at the
    // order total). Pre-computing here avoids the partial-auth-vs-order-
    // total mismatch that Square otherwise throws on complete.
    const gcAmountCents = Math.min(gcInfo.balanceCents, totalCents);

    const gcAuth = await authorizeGiftCardPayment({
      orderId,
      locationId,
      nonce: giftCardNonce,
      amountCents: gcAmountCents,
      baseKey,
    });
    gcPaymentId = gcAuth.paymentId;
    gcApprovedCents = gcAuth.approvedCents;
  }

  const remainingCents = totalCents - gcApprovedCents;

  // ── Step B: Authorize card / wallet for remainder (if needed) ─────
  let cardPaymentId: string | undefined;
  let cardApprovedCents = 0;

  if (remainingCents > 0) {
    if (!cardSourceId) {
      // GC didn't cover and we have no card to fall back on. Cancel
      // the GC auth (it would have settled the partial amount on
      // complete) and bail. The customer was never charged.
      if (gcPaymentId) {
        await cancelSquarePayment(gcPaymentId, baseKey, "gc");
      }
      throw new SquarePaymentError(
        "INSUFFICIENT_GIFT_CARD",
        "Gift card balance is less than the total. Please add a card for the remainder.",
      );
    }
    try {
      const cardAuth = await authorizeCardPayment({
        orderId,
        locationId,
        sourceId: cardSourceId,
        amountCents: remainingCents,
        baseKey,
        customerId: params.customerId,
        buyerEmail: params.buyerEmail,
        note: params.note,
      });
      cardPaymentId = cardAuth.paymentId;
      cardApprovedCents = remainingCents;
    } catch (err) {
      // Card auth failed → void the GC auth so the customer's GC
      // balance is preserved.
      if (gcPaymentId) {
        await cancelSquarePayment(gcPaymentId, baseKey, "gc");
      }
      throw err;
    }
  }

  // ── Step C: Complete both authorizations ──────────────────────────
  // If either complete fails, cancel everything still cancellable.
  // (A completed payment can no longer be cancelled — would need a
  // refund. With autocomplete: false and an explicit complete step,
  // failures here are rare; we treat them as auth failures.)
  try {
    if (gcPaymentId) await completeSquarePayment(gcPaymentId, baseKey, "gc");
    if (cardPaymentId) await completeSquarePayment(cardPaymentId, baseKey, "card");
  } catch (err) {
    // Best-effort cleanup. Auths that haven't completed can still be
    // cancelled. Any payment that already completed will silently fail
    // here — Square returns 4xx on cancel-after-complete and we
    // already swallow those in cancelSquarePayment.
    if (gcPaymentId) await cancelSquarePayment(gcPaymentId, baseKey, "gc");
    if (cardPaymentId) await cancelSquarePayment(cardPaymentId, baseKey, "card");
    throw err;
  }

  return {
    gcPaymentId,
    cardPaymentId,
    gcApprovedCents,
    cardApprovedCents,
    gcGan,
  };
}
