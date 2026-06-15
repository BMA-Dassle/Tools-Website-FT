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
 *
 * ── Gift-card-SALE model (flag DEPOSIT_GC_SALE_V2) ────────────────────────
 * When the flag is on, the deposit order's line item is typed `GIFT_CARD` and
 * the ACTIVATE links to it via `order_id` + `line_item_uid` (the same proven
 * pattern as `mintDigitalGiftCard`), instead of `amount_money` +
 * `buyer_payment_instrument_ids`. Square then books the deposit as a gift-card
 * SALE (excluded from gross sales) rather than a plain itemized sale — which
 * stops the deposit from being counted in gross sales twice (once on the
 * deposit order, once again when the gift card is redeemed against the day-of
 * order). Customer-visible behaviour (charge, custom GAN, balance, lane-open
 * redemption) is unchanged; only Square's revenue classification changes.
 *
 * Flag OFF = byte-for-byte the original behaviour. The recovery path keys off
 * the deposit order's actual line-item type (not the live flag), so retries are
 * always consistent with how the order was originally created.
 */
import { randomBytes } from "crypto";
import { authorizeMultiTender, SquarePaymentError } from "@/lib/square-gift-card";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

/** Single line-item name for every booking-path deposit (race/attraction/
 *  bowling) so the receipt + sales reports read consistently. */
const DEPOSIT_LINE_ITEM_NAME = "Reservation Deposit";

/**
 * Gift-card-sale model toggle. Read at call time (not module load) so tests and
 * a preview deploy can flip it via env without a rebuild. Default OFF — opt in
 * with DEPOSIT_GC_SALE_V2="true". See the header note above.
 */
export function giftCardSaleEnabled(): boolean {
  return process.env.DEPOSIT_GC_SALE_V2 === "true";
}

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
  const saleMode = giftCardSaleEnabled();

  // ── 1. Deposit order ─────────────────────────────────────────────────
  // In gift-card-sale mode the single line item is typed GIFT_CARD so Square
  // books it as a gift-card sale (not gross sales). No tax either way — the
  // deposit is already a fraction of the tax-inclusive day-of total.
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
            name: DEPOSIT_LINE_ITEM_NAME,
            quantity: "1",
            ...(saleMode ? { item_type: "GIFT_CARD" } : {}),
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
  // GIFT_CARD activation links to this line item by uid. Captured from the
  // create response so we never have to re-fetch the order on the happy path.
  const depositLineItemUid: string | undefined = depositOrderData.order?.line_items?.[0]?.uid;
  if (saleMode && !depositLineItemUid) {
    throw new Error("GIFT_CARD deposit order returned no line item uid");
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
      ...(saleMode && depositLineItemUid
        ? { depositOrderId, lineItemUid: depositLineItemUid }
        : {}),
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
  /**
   * Gift-card-sale (v2) recovery/activation link. When BOTH are set, ACTIVATE
   * uses `order_id` + `line_item_uid` (Square reads the load amount off the
   * GIFT_CARD line item) instead of `amount_money` + `buyer_payment_instrument_ids`.
   * The two forms are mutually exclusive — Square rejects a request that carries
   * both. Omit them for the legacy (flag-off) path.
   */
  depositOrderId?: string;
  lineItemUid?: string;
}): Promise<{ giftCardId: string; giftCardGan: string }> {
  const customGan = `${params.ganPrefix}${params.ganSuffix}`.replace(/[^A-Za-z0-9]/g, "");
  const useCustomGan = customGan.length >= 8 && customGan.length <= 20;
  const orderLinked = Boolean(params.depositOrderId && params.lineItemUid);

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
        // Order-linked and amount/instrument forms are mutually exclusive —
        // Square errors if both appear in activate_activity_details.
        activate_activity_details: orderLinked
          ? { order_id: params.depositOrderId, line_item_uid: params.lineItemUid }
          : {
              amount_money: { amount: params.amountCents, currency: "USD" },
              buyer_payment_instrument_ids: params.paymentIds,
            },
      },
    }),
  });
  const activateData = await activateRes.json().catch(() => ({}));
  // Square can return HTTP 200 with `errors` populated (e.g. an idempotency
  // replay of a prior failure), so checking `!ok` alone misses those.
  if (!activateRes.ok || activateData.errors?.length) {
    const sqErr = activateData.errors?.[0];
    throw new Error(
      `gift card activation failed: ${sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(activateData)}`,
    );
  }
  // Order-linked ACTIVATE has a silent "$0 PENDING card" failure mode (see
  // mintDigitalGiftCard) — verify a real balance came back before returning.
  if (orderLinked) {
    const loaded =
      activateData.gift_card_activity?.gift_card_balance_money?.amount ??
      activateData.gift_card_activity?.activate_activity_details?.amount_money?.amount ??
      0;
    if (!loaded) {
      throw new Error("gift card activation returned a $0 balance (order-linked)");
    }
  }
  return { giftCardId, giftCardGan };
}

/**
 * Fetch the single line item on a deposit order — its uid + item_type. Used by
 * race-confirm-reconcile to decide how to recover a gift card whose creation
 * failed after capture: if the deposit order's line item is `GIFT_CARD` (the
 * v2 sale model), recover via the order link so the recovered card is also
 * booked as a gift-card sale; otherwise fall back to the legacy
 * buyer_payment_instrument path. Returns null on any fetch error (caller then
 * uses the legacy path). Reads the order's actual type rather than the live
 * flag, so recovery always matches how the order was originally created.
 */
export async function getDepositOrderLineItem(
  orderId: string,
): Promise<{ uid: string; itemType: string } | null> {
  try {
    const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: sqHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const li = data.order?.line_items?.[0];
    if (!li?.uid) return null;
    return { uid: li.uid as string, itemType: (li.item_type as string) ?? "" };
  } catch {
    return null;
  }
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
