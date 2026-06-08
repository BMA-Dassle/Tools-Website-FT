/**
 * Shared deposit service — deposit order + multi-tender auth + eGift card.
 *
 * Extracted from /api/square/bowling-orders so ALL booking types (race,
 * attraction, bowling) follow the same deposit lifecycle:
 *
 *   1. Create deposit order  (single line item, no tax — deposit is a
 *      fraction of the tax-inclusive day-of total)
 *   2. authorizeMultiTender  (GC partial + card remainder)
 *   3. Create DIGITAL gift card with custom GAN
 *   4. ACTIVATE gift card with deposit amount
 *
 * On failure at any step, previous steps are rolled back.
 */
import { randomBytes } from "crypto";
import { authorizeMultiTender, SquarePaymentError } from "@/lib/square-gift-card";

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

// ── Public types ────────────────────────────────────────────────────────

export interface DepositParams {
  amountCents: number;
  locationId: string;
  cardSourceId?: string;
  giftCardNonce?: string;
  squareCustomerId?: string;
  /** GAN prefix — "RACE", "ATTR", "HPFM", etc. */
  ganPrefix: string;
  /** GAN suffix — BMI bill ID last 8 chars, QAMF reservation ID, etc. */
  ganSuffix: string;
  /** Reference note shown on deposit order in Square Dashboard. */
  note: string;
  /** Idempotency base key. Auto-generated if omitted. */
  baseKey?: string;
}

export interface DepositResult {
  depositOrderId: string;
  depositPaymentId: string;
  /** Null when the deposit was CAPTURED but gift-card create/activate failed
   *  (see giftCardPending) — the booking is recovered forward, not refunded. */
  giftCardId: string | null;
  giftCardGan: string | null;
  gcApprovedCents: number;
  cardApprovedCents: number;
  /** True = card captured but the gift card isn't funded yet. The caller MUST
   *  persist a recoverable anchor; race-confirm-reconcile re-runs create+activate
   *  (idempotent via baseKey). */
  giftCardPending?: boolean;
  gcError?: string;
}

export const FRIENDLY_PAYMENT_ERRORS: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
  GENERIC_DECLINE: "Card declined. Please try a different card.",
  INVALID_EXPIRATION: "Card expired. Please use a different card.",
  CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
  CARD_EXPIRED: "Card expired. Please use a different card.",
  CARD_DECLINED: "Card declined. Please try a different card.",
  CARD_DECLINED_VERIFICATION_REQUIRED: "Additional verification required. Please try again.",
  VERIFY_AVS_FAILURE: "Address verification failed. Check your billing zip code and try again.",
  ADDRESS_VERIFICATION_FAILURE:
    "Address verification failed. Check your billing zip code and try again.",
  CARD_TOKEN_USED_BEFORE: "Payment token already used. Please re-enter your card details.",
  CARD_TOKEN_EXPIRED: "Payment session expired. Please re-enter your card details.",
  INVALID_CARD: "Card number could not be validated. Please check and try again.",
  TRANSACTION_LIMIT: "Transaction limit exceeded. Please try a different card.",
  BAD_EXPIRATION: "Card expiration date is invalid. Please check and try again.",
};

// ── Core: create deposit + charge + gift card ───────────────────────────

export async function createDepositAndCharge(params: DepositParams): Promise<DepositResult> {
  const {
    amountCents,
    locationId,
    cardSourceId,
    giftCardNonce,
    squareCustomerId,
    ganPrefix,
    ganSuffix,
    note,
  } = params;

  if (amountCents <= 0) {
    throw new Error("Deposit amount must be > 0");
  }
  if (!cardSourceId && !giftCardNonce) {
    throw new Error("cardSourceId or giftCardNonce required for deposit");
  }

  const baseKey = params.baseKey ?? randomBytes(8).toString("hex");

  // ── 1. Deposit order ─────────────────────────────────────────────────
  const depositOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `dep-order-${baseKey}`,
      order: {
        location_id: locationId,
        reference_id: note.slice(0, 40),
        line_items: [
          {
            name: "Reservation Deposit",
            quantity: "1",
            base_price_money: { amount: amountCents, currency: "USD" },
          },
        ],
      },
    }),
  });
  const depositOrderData = await depositOrderRes.json();

  if (!depositOrderRes.ok || depositOrderData.errors) {
    const sqErr = depositOrderData.errors?.[0];
    const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(depositOrderData);
    throw new Error(`Failed to create deposit order: ${detail}`);
  }

  const depositOrderId: string = depositOrderData.order?.id;
  if (!depositOrderId) {
    throw new Error("Deposit order returned no ID");
  }

  // ── 2. Charge via multi-tender ───────────────────────────────────────
  let gcPaymentId: string | undefined;
  let cardPaymentId: string | undefined;
  let gcApprovedCents = 0;
  let cardApprovedCents = 0;

  try {
    const multiTender = await authorizeMultiTender({
      orderId: depositOrderId,
      locationId,
      totalCents: amountCents,
      baseKey,
      giftCardNonce,
      cardSourceId,
      customerId: squareCustomerId,
      note,
    });
    gcPaymentId = multiTender.gcPaymentId ?? undefined;
    cardPaymentId = multiTender.cardPaymentId ?? undefined;
    gcApprovedCents = multiTender.gcApprovedCents;
    cardApprovedCents = multiTender.cardApprovedCents;
  } catch (err) {
    if (err instanceof SquarePaymentError) {
      const friendly =
        FRIENDLY_PAYMENT_ERRORS[err.code] ??
        err.message ??
        "Payment could not be processed. Please try again.";
      throw new DepositPaymentError(err.code, friendly, err.message);
    }
    throw err;
  }

  const depositPaymentId = (cardPaymentId || gcPaymentId) as string;
  if (!depositPaymentId) {
    throw new Error("Payment succeeded but returned no ID");
  }

  // ── 3 + 4. Create + ACTIVATE the gift card from the CAPTURED deposit ──
  // The card is already captured (payOrder). If gift-card create/activate fails
  // here, do NOT throw away the captured-payment context — return a partial
  // result (giftCardPending) so the caller persists a recoverable anchor and the
  // race-confirm-reconcile cron re-runs create+activate (idempotent via baseKey,
  // so no double-load). The money is safely captured, never silently lost.
  try {
    const { giftCardId, giftCardGan } = await activateGiftCardForDeposit({
      baseKey,
      locationId,
      amountCents,
      ganPrefix,
      ganSuffix,
      paymentIds: [gcPaymentId, cardPaymentId].filter((id): id is string => Boolean(id)),
    });
    console.log(
      `[deposit] success depositOrderId=${depositOrderId} amount=${amountCents} gc=${gcApprovedCents} card=${cardApprovedCents}`,
    );
    return {
      depositOrderId,
      depositPaymentId,
      giftCardId,
      giftCardGan,
      gcApprovedCents,
      cardApprovedCents,
    };
  } catch (gcErr) {
    const detail = gcErr instanceof Error ? gcErr.message : String(gcErr);
    console.error(
      "[deposit] gift card create/activate failed AFTER capture (recoverable):",
      detail,
    );
    return {
      depositOrderId,
      depositPaymentId,
      giftCardId: null,
      giftCardGan: null,
      gcApprovedCents,
      cardApprovedCents,
      giftCardPending: true,
      gcError: detail,
    };
  }
}

/**
 * Create a DIGITAL gift card with the custom GAN and ACTIVATE it with the
 * deposit amount, funded by the given (already-captured) payment ids. Idempotent
 * via `gc-${baseKey}` / `gc-act-${baseKey}` — a retry with the same baseKey
 * returns the same card and never double-loads. Throws on failure.
 *
 * Used by createDepositAndCharge (happy path) AND race-confirm-reconcile (to
 * fund a gift card whose creation failed after capture).
 */
export async function activateGiftCardForDeposit(params: {
  baseKey: string;
  locationId: string;
  amountCents: number;
  ganPrefix: string;
  ganSuffix: string;
  paymentIds: string[];
}): Promise<{ giftCardId: string; giftCardGan: string }> {
  const customGan = `${params.ganPrefix}${params.ganSuffix}`.replace(/[^A-Za-z0-9]/g, "");
  const useCustomGan = customGan.length >= 8 && customGan.length <= 20;

  const giftCardRes = await fetch(`${SQUARE_BASE}/gift-cards`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gc-${params.baseKey}`,
      location_id: params.locationId,
      gift_card: {
        type: "DIGITAL",
        ...(useCustomGan ? { gan_source: "OTHER", gan: customGan } : {}),
      },
    }),
  });
  const giftCardData = await giftCardRes.json();
  if (!giftCardRes.ok || giftCardData.errors) {
    const sqErr = giftCardData.errors?.[0];
    throw new Error(
      `gift card creation failed: ${sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(giftCardData)}`,
    );
  }
  const giftCardId: string = giftCardData.gift_card?.id;
  const giftCardGan: string = giftCardData.gift_card?.gan;
  if (!giftCardId || !giftCardGan) throw new Error("Gift card creation returned no ID or GAN");

  const activateRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gc-act-${params.baseKey}`,
      gift_card_activity: {
        type: "ACTIVATE",
        location_id: params.locationId,
        gift_card_id: giftCardId,
        activate_activity_details: {
          amount_money: { amount: params.amountCents, currency: "USD" },
          buyer_payment_instrument_ids: params.paymentIds,
        },
      },
    }),
  });
  const activateData = await activateRes.json();
  if (!activateRes.ok || activateData.errors) {
    const sqErr = activateData.errors?.[0];
    throw new Error(
      `gift card activation failed: ${sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(activateData)}`,
    );
  }
  return { giftCardId, giftCardGan };
}

// NOTE: `rollbackDeposit` was removed (2026-06-07, blocker #2). The deposit is
// CAPTURED inside createDepositAndCharge (payOrder), so /payments/{id}/cancel
// 4xx's and can't reverse it — a "rollback" here silently failed to return the
// money. The model now recovers FORWARD: a downstream failure leaves a durable
// confirm_pending/confirm_failed anchor that race-confirm-reconcile drives to
// confirmed (the funds stay on the gift card). For a genuine refund, use the
// admin-only `refundSquarePayment` in lib/square-gift-card.ts.

// ── Error class for payment-specific failures ───────────────────────────

export class DepositPaymentError extends Error {
  code: string;
  friendlyMessage: string;

  constructor(code: string, friendlyMessage: string, detail?: string) {
    super(detail ?? friendlyMessage);
    this.name = "DepositPaymentError";
    this.code = code;
    this.friendlyMessage = friendlyMessage;
  }
}
