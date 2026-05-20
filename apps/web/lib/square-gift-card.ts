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

/**
 * Atomically capture all authorized payments attached to an order.
 *
 * This is the correct primitive for multi-tender: Square's per-payment
 * `CompletePayment` validates that each payment's amount is enough to
 * cover the remaining order balance — so completing only the gift card
 * on a card+GC order fails (the order still owes the card's portion).
 * `PayOrder` settles all listed payments together and closes the order
 * in one transaction.
 *
 * Works equally well for single-tender (one payment_id in the list).
 *
 * Endpoint: POST /v2/orders/{orderId}/pay
 */
export async function payOrder(params: {
  orderId: string;
  paymentIds: string[];
  baseKey: string;
}): Promise<void> {
  const res = await fetch(`${SQUARE_BASE}/orders/${params.orderId}/pay`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `payorder-${params.baseKey}`,
      payment_ids: params.paymentIds,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const e = data.errors?.[0];
    throw new SquarePaymentError(
      e?.code || "PAY_ORDER_FAILED",
      e?.detail || "Order payment capture failed",
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
  /** HTTP status from Square, when the error came from a 4xx/5xx response. */
  status?: number;
  constructor(code: string, detail: string, status?: number) {
    super(detail);
    this.code = code;
    if (status != null) this.status = status;
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

  // ── Step C: Capture all authorizations atomically via PayOrder ────
  // Per-payment CompletePayment validates each payment against the
  // remaining order balance, so capturing only the gift card on a
  // GC+card order fails (the order still owes the card's portion).
  // PayOrder settles every listed payment and closes the order in one
  // transaction. Works for single-tender too.
  const paymentIds = [gcPaymentId, cardPaymentId].filter((id): id is string => Boolean(id));
  try {
    await payOrder({ orderId, paymentIds, baseKey });
  } catch (err) {
    // Best-effort cleanup. Any auth that wasn't captured is still
    // voidable; the swallowed cancel failures cover the
    // already-captured case (Square returns 4xx on cancel-after-capture).
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

// ═════════════════════════════════════════════════════════════════════
// Reward issuance helpers (PR-GS3: guest survey reward picker)
//
// The helpers below mint gift cards and credit Loyalty points outbound
// to customers as marketing rewards. They are NOT used by the customer
// payment flows above — those flows REDEEM gift cards customers already
// own. These flows ISSUE new gift cards / points the customer hasn't
// paid for.
// ═════════════════════════════════════════════════════════════════════

export interface MintGiftCardResult {
  giftCardId: string;
  gan: string;
  balanceCents: number;
}

/**
 * Mint a new DIGITAL Square Gift Card via the merchant-comp **Order +
 * Discount** pattern (the only one Square actually accepts — confirmed
 * after a live 502 on the simpler ACTIVATE-with-amount approach: Square
 * returns "Provide either order_id and line_item_uid OR provide amount
 * and buyer_payment_instrument_id"):
 *
 *   1. POST /v2/orders                  — create an order with a $X eGiftCard
 *                                          line item + a $X catalog discount
 *                                          (net total = $0). The discount
 *                                          books the comp against GL 500.088
 *                                          via the "Gift Card - Guest Survey
 *                                          (500.088)" catalog discount object.
 *   2. POST /v2/orders/{id}/pay         — pay the $0 order with empty
 *                                          payment_ids. Square closes it.
 *   3. POST /v2/gift-cards              — create the DIGITAL gift card.
 *   4. POST /v2/gift-cards/activities   — ACTIVATE with activate_activity_details
 *                                          referencing order_id + line_item_uid.
 *                                          Square sets the balance to the line
 *                                          item's base price; the discount is
 *                                          a merchant accounting trick — gift
 *                                          card still activates at full value.
 *
 * Pandora_API uses this exact pattern in prod (see src/utils/square.utils.ts
 * createGiftCardOrder / activateGiftCardByOrder + the createTracked
 * orchestration in squareV2.controllers.ts).
 *
 * Per business decision (2026-05-20): no expiration set — Square Gift
 * Cards default to never expire and we keep that.
 */
export async function mintDigitalGiftCard(params: {
  locationId: string;
  amountCents: number;
  baseKey: string;
  /** Catalog id of the merchant-comp discount object that zeroes the
   *  order (e.g. "Gift Card - Guest Survey (500.088)"). Must be a real
   *  catalog discount, not ad-hoc, so the GL booking lands correctly. */
  discountCatalogObjectId: string;
}): Promise<MintGiftCardResult> {
  // ── 1. Create order: $X eGiftCard line + $X catalog discount → $0 ─
  const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gc-order-${params.baseKey}`,
      order: {
        location_id: params.locationId,
        line_items: [
          {
            name: "eGiftCard",
            quantity: "1",
            item_type: "GIFT_CARD",
            base_price_money: { amount: params.amountCents, currency: "USD" },
          },
        ],
        discounts: [
          {
            amount_money: { amount: params.amountCents, currency: "USD" },
            catalog_object_id: params.discountCatalogObjectId,
          },
        ],
      },
    }),
  });
  if (!orderRes.ok) {
    const data = await orderRes.json().catch(() => ({}));
    const code = data.errors?.[0]?.code || "GIFT_CARD_ORDER_FAILED";
    const detail = data.errors?.[0]?.detail || `status ${orderRes.status}`;
    console.error("[square-gift-card] mint order failed:", {
      code,
      detail,
      status: orderRes.status,
    });
    throw new SquarePaymentError(code, detail, orderRes.status);
  }
  const orderData = (await orderRes.json()) as {
    order?: { id?: string; line_items?: Array<{ uid?: string }> };
  };
  const orderId = orderData.order?.id;
  const lineItemUid = orderData.order?.line_items?.[0]?.uid;
  if (!orderId || !lineItemUid) {
    throw new SquarePaymentError(
      "GIFT_CARD_ORDER_INCOMPLETE",
      "Square returned no order.id or line_items[0].uid",
      500,
    );
  }

  // ── 2. Pay the $0 order (empty payment_ids — discount covered it) ─
  const payRes = await fetch(`${SQUARE_BASE}/orders/${orderId}/pay`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gc-pay-${params.baseKey}`,
      payment_ids: [],
    }),
  });
  if (!payRes.ok) {
    const data = await payRes.json().catch(() => ({}));
    const code = data.errors?.[0]?.code || "GIFT_CARD_PAY_FAILED";
    const detail = data.errors?.[0]?.detail || `status ${payRes.status}`;
    console.error("[square-gift-card] mint pay-order failed:", {
      code,
      detail,
      status: payRes.status,
      orderId,
    });
    throw new SquarePaymentError(code, detail, payRes.status);
  }

  // ── 3. Create the DIGITAL gift card (PENDING, balance 0) ─────────
  const createRes = await fetch(`${SQUARE_BASE}/gift-cards`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gc-mint-${params.baseKey}`,
      location_id: params.locationId,
      gift_card: { type: "DIGITAL" },
    }),
  });
  if (!createRes.ok) {
    const data = await createRes.json().catch(() => ({}));
    const code = data.errors?.[0]?.code || "GIFT_CARD_CREATE_FAILED";
    const detail = data.errors?.[0]?.detail || `status ${createRes.status}`;
    console.error("[square-gift-card] mint create failed:", {
      code,
      detail,
      status: createRes.status,
    });
    throw new SquarePaymentError(code, detail, createRes.status);
  }
  const createData = (await createRes.json()) as {
    gift_card?: { id?: string; gan?: string };
  };
  const giftCardId = createData.gift_card?.id;
  const gan = createData.gift_card?.gan;
  if (!giftCardId || !gan) {
    throw new SquarePaymentError(
      "GIFT_CARD_CREATE_INCOMPLETE",
      "Square returned no gift_card.id or .gan",
      500,
    );
  }

  // ── 4. ACTIVATE by order → balance set from the line item ────────
  const actRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gc-act-${params.baseKey}`,
      gift_card_activity: {
        type: "ACTIVATE",
        location_id: params.locationId,
        gift_card_id: giftCardId,
        activate_activity_details: {
          order_id: orderId,
          line_item_uid: lineItemUid,
        },
      },
    }),
  });
  if (!actRes.ok) {
    const data = await actRes.json().catch(() => ({}));
    const code = data.errors?.[0]?.code || "GIFT_CARD_ACTIVATE_FAILED";
    const detail = data.errors?.[0]?.detail || `status ${actRes.status}`;
    console.error("[square-gift-card] mint activate failed:", {
      code,
      detail,
      status: actRes.status,
      giftCardId,
      orderId,
      lineItemUid,
    });
    throw new SquarePaymentError(code, detail, actRes.status);
  }

  return { giftCardId, gan, balanceCents: params.amountCents };
}

export interface LoyaltyAccountSummary {
  accountId: string;
  customerId: string | null;
  balance: number;
  lifetimePoints: number;
}

/**
 * Look up the loyalty account for a Square customer.
 * Returns null if no account exists.
 */
export async function findLoyaltyAccount(
  customerId: string,
): Promise<LoyaltyAccountSummary | null> {
  const res = await fetch(`${SQUARE_BASE}/loyalty/accounts/search`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      query: { customer_ids: [customerId] },
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.errors?.[0]?.code || "LOYALTY_SEARCH_FAILED";
    const detail = data.errors?.[0]?.detail || `status ${res.status}`;
    throw new SquarePaymentError(code, detail, res.status);
  }
  const data = (await res.json()) as {
    loyalty_accounts?: Array<{
      id?: string;
      customer_id?: string;
      balance?: number;
      lifetime_points?: number;
    }>;
  };
  const acct = data.loyalty_accounts?.[0];
  if (!acct?.id) return null;
  return {
    accountId: acct.id,
    customerId: acct.customer_id ?? null,
    balance: acct.balance ?? 0,
    lifetimePoints: acct.lifetime_points ?? 0,
  };
}

interface LoyaltyProgramCache {
  programId: string;
  fetchedAt: number;
}
let cachedLoyaltyProgram: LoyaltyProgramCache | null = null;
const LOYALTY_PROGRAM_TTL_MS = 60 * 60 * 1000; // 1h

async function getLoyaltyProgramId(): Promise<string> {
  const now = Date.now();
  if (cachedLoyaltyProgram && now - cachedLoyaltyProgram.fetchedAt < LOYALTY_PROGRAM_TTL_MS) {
    return cachedLoyaltyProgram.programId;
  }
  const res = await fetch(`${SQUARE_BASE}/loyalty/programs/main`, {
    method: "GET",
    headers: sqHeaders(),
  });
  if (!res.ok) {
    throw new SquarePaymentError(
      "LOYALTY_PROGRAM_FETCH_FAILED",
      `status ${res.status}`,
      res.status,
    );
  }
  const data = (await res.json()) as { program?: { id?: string } };
  const programId = data.program?.id;
  if (!programId) {
    throw new SquarePaymentError(
      "LOYALTY_PROGRAM_MISSING",
      "No 'main' loyalty program returned",
      500,
    );
  }
  cachedLoyaltyProgram = { programId, fetchedAt: now };
  return programId;
}

/**
 * Get a customer's loyalty account, enrolling them if none exists.
 * The enrollment maps the customer's phone to the loyalty program — same
 * pattern as /api/square/loyalty/enroll.
 */
export async function ensureLoyaltyEnrollment(params: {
  customerId: string;
  phoneE164: string;
  baseKey: string;
}): Promise<LoyaltyAccountSummary> {
  const existing = await findLoyaltyAccount(params.customerId);
  if (existing) return existing;

  const programId = await getLoyaltyProgramId();

  const res = await fetch(`${SQUARE_BASE}/loyalty/accounts`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `loy-enroll-${params.baseKey}`,
      loyalty_account: {
        program_id: programId,
        mapping: { phone_number: params.phoneE164 },
      },
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.errors?.[0]?.code || "LOYALTY_ENROLL_FAILED";
    const detail = data.errors?.[0]?.detail || `status ${res.status}`;
    throw new SquarePaymentError(code, detail, res.status);
  }
  const data = (await res.json()) as {
    loyalty_account?: {
      id?: string;
      customer_id?: string;
      balance?: number;
      lifetime_points?: number;
    };
  };
  const acct = data.loyalty_account;
  if (!acct?.id) {
    throw new SquarePaymentError(
      "LOYALTY_ENROLL_INCOMPLETE",
      "Square returned no loyalty_account.id",
      500,
    );
  }
  return {
    accountId: acct.id,
    customerId: acct.customer_id ?? params.customerId,
    balance: acct.balance ?? 0,
    lifetimePoints: acct.lifetime_points ?? 0,
  };
}

export interface CreditLoyaltyResult {
  eventId: string;
  newBalance: number;
}

/**
 * Add points to a loyalty account using Square's adjust endpoint.
 * Returns the adjustment event id (for audit) + the post-adjust balance.
 *
 * `reason` is a free-text label shown in the Square dashboard's loyalty
 * activity log. Keep it short and descriptive — e.g. "Guest Survey Reward".
 */
export async function creditLoyaltyPoints(params: {
  accountId: string;
  points: number;
  reason: string;
  baseKey: string;
}): Promise<CreditLoyaltyResult> {
  if (params.points <= 0) {
    throw new SquarePaymentError(
      "LOYALTY_INVALID_POINTS",
      `points must be > 0 (got ${params.points})`,
      400,
    );
  }
  const res = await fetch(`${SQUARE_BASE}/loyalty/accounts/${params.accountId}/adjust`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `loy-adj-${params.baseKey}`,
      adjust_points: {
        points: params.points,
        reason: params.reason,
      },
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.errors?.[0]?.code || "LOYALTY_ADJUST_FAILED";
    const detail = data.errors?.[0]?.detail || `status ${res.status}`;
    throw new SquarePaymentError(code, detail, res.status);
  }
  const data = (await res.json()) as {
    event?: { id?: string; loyalty_account_id?: string };
  };
  const eventId = data.event?.id;
  if (!eventId) {
    throw new SquarePaymentError(
      "LOYALTY_ADJUST_INCOMPLETE",
      "Square returned no event.id from adjust",
      500,
    );
  }

  // Re-fetch the account to get the new balance (the adjust response
  // doesn't include it).
  let newBalance = 0;
  try {
    const acctRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/${params.accountId}`, {
      method: "GET",
      headers: sqHeaders(),
    });
    if (acctRes.ok) {
      const acctData = (await acctRes.json()) as { loyalty_account?: { balance?: number } };
      newBalance = acctData.loyalty_account?.balance ?? 0;
    }
  } catch {
    // Non-fatal — balance is a nice-to-have for the confirmation SMS.
  }

  return { eventId, newBalance };
}

/**
 * Append a line to the Square customer's free-text note field.
 *
 * Square's PUT /v2/customers/{id} replaces the note wholesale, so we
 * fetch the current value first and prepend the new line. Fail-soft:
 * note updates are nice-to-have for ops visibility, not transactional.
 */
export async function appendCustomerNote(params: {
  customerId: string;
  line: string;
}): Promise<void> {
  const getRes = await fetch(`${SQUARE_BASE}/customers/${params.customerId}`, {
    headers: sqHeaders(),
  });
  if (!getRes.ok) {
    throw new SquarePaymentError("CUSTOMER_GET_FAILED", `status ${getRes.status}`, getRes.status);
  }
  const getData = (await getRes.json()) as { customer?: { note?: string } };
  const existing = getData.customer?.note ?? "";
  const newNote = existing ? `${params.line}\n${existing}` : params.line;

  const putRes = await fetch(`${SQUARE_BASE}/customers/${params.customerId}`, {
    method: "PUT",
    headers: sqHeaders(),
    body: JSON.stringify({ note: newNote }),
  });
  if (!putRes.ok) {
    throw new SquarePaymentError("CUSTOMER_PUT_FAILED", `status ${putRes.status}`, putRes.status);
  }
}

/** Reset the in-process loyalty-program cache. Test-only. @internal */
export function _resetLoyaltyProgramCache(): void {
  cachedLoyaltyProgram = null;
}
