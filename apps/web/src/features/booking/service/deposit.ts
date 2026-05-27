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
  giftCardId: string;
  giftCardGan: string;
  gcApprovedCents: number;
  cardApprovedCents: number;
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

  // ── 3. Create DIGITAL gift card with custom GAN ──────────────────────
  const customGan = `${ganPrefix}${ganSuffix}`.replace(/[^A-Za-z0-9]/g, "");
  const useCustomGan = customGan.length >= 8 && customGan.length <= 20;

  const giftCardRes = await fetch(`${SQUARE_BASE}/gift-cards`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gc-${baseKey}`,
      location_id: locationId,
      gift_card: {
        type: "DIGITAL",
        ...(useCustomGan ? { gan_source: "OTHER", gan: customGan } : {}),
      },
    }),
  });
  const giftCardData = await giftCardRes.json();

  if (!giftCardRes.ok || giftCardData.errors) {
    const sqErr = giftCardData.errors?.[0];
    const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(giftCardData);
    console.error("[deposit] gift card creation failed after payment:", detail);
    throw new Error(`Payment captured but gift card creation failed: ${detail}`);
  }

  const giftCardId: string = giftCardData.gift_card?.id;
  const giftCardGan: string = giftCardData.gift_card?.gan;
  if (!giftCardId || !giftCardGan) {
    throw new Error("Gift card creation returned no ID or GAN");
  }

  // ── 4. Activate gift card ────────────────────────────────────────────
  const activateRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gc-act-${baseKey}`,
      gift_card_activity: {
        type: "ACTIVATE",
        location_id: locationId,
        gift_card_id: giftCardId,
        activate_activity_details: {
          amount_money: { amount: amountCents, currency: "USD" },
          buyer_payment_instrument_ids: [gcPaymentId, cardPaymentId].filter((id): id is string =>
            Boolean(id),
          ),
        },
      },
    }),
  });
  const activateData = await activateRes.json();

  if (!activateRes.ok || activateData.errors) {
    const sqErr = activateData.errors?.[0];
    const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(activateData);
    console.error("[deposit] gift card activation failed:", detail);
    throw new Error(`Payment captured but gift card activation failed: ${detail}`);
  }

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
}

// ── Rollback: cancel deposit payments ───────────────────────────────────

export async function rollbackDeposit(
  depositOrderId: string,
  paymentIds: { gc?: string; card?: string },
): Promise<void> {
  const toCancel = [paymentIds.gc, paymentIds.card].filter(Boolean) as string[];

  for (const paymentId of toCancel) {
    try {
      const res = await fetch(`${SQUARE_BASE}/payments/${paymentId}/cancel`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error(`[deposit] rollback cancel payment ${paymentId} failed:`, data);
      } else {
        console.log(`[deposit] rolled back payment ${paymentId}`);
      }
    } catch (err) {
      console.error(`[deposit] rollback error for ${paymentId}:`, err);
    }
  }

  // Cancel the deposit order itself
  try {
    const getRes = await fetch(`${SQUARE_BASE}/orders/${depositOrderId}`, {
      headers: sqHeaders(),
    });
    if (getRes.ok) {
      const getData = await getRes.json();
      const version = getData.order?.version;
      if (version != null) {
        const cancelRes = await fetch(`${SQUARE_BASE}/orders/${depositOrderId}`, {
          method: "PUT",
          headers: sqHeaders(),
          body: JSON.stringify({
            order: {
              location_id: getData.order?.location_id,
              state: "CANCELED",
              version,
            },
          }),
        });
        if (!cancelRes.ok) {
          const cancelData = await cancelRes.json().catch(() => ({}));
          console.error(`[deposit] rollback cancel order ${depositOrderId} failed:`, cancelData);
        }
      }
    }
  } catch (err) {
    console.error(`[deposit] rollback order cancel error:`, err);
  }
}

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
