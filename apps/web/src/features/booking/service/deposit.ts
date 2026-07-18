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
import {
  authorizeMultiTender,
  GIFT_CARD_MAX_CENTS,
  SquarePaymentError,
} from "@/lib/square-gift-card";
import { composeGan } from "@/lib/gan";

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

/**
 * Split a total into gift-card chunks, each ≤ the $2,000/card Square cap. A
 * deposit (esp. group events) that exceeds $2k must fund multiple cards; in the
 * gift-card-sale model each chunk also becomes its own `GIFT_CARD` line item so
 * a card can ACTIVATE against it by `line_item_uid`. Order is preserved so the
 * Nth chunk maps to the Nth line item. Returns [] for a non-positive total.
 *
 * Examples: 4399 → [4399]; 250000 → [200000, 50000]; 400000 → [200000, 200000].
 */
export function giftCardSaleChunks(totalCents: number): number[] {
  const chunks: number[] = [];
  let remaining = totalCents;
  while (remaining > 0) {
    const chunk = Math.min(remaining, GIFT_CARD_MAX_CENTS);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
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

/**
 * Kiosk direct-Terminal charge (owner rule: NO saved card). Threaded through the
 * reserve rails; when present, the guest's card was ALREADY captured on the paired
 * Square reader against OUR deposit order, so reserve records it as collected and
 * NEVER charges a token. Only honored when kioskTerminalEnabled(); otherwise ignored.
 */
export interface ExternalTerminalPayment {
  /** Square paymentId the reader produced (must be COMPLETED). */
  paymentId: string;
  /** The deposit order the reader paid. Echoed for logging only — finalize
   *  RE-DERIVES the authoritative id from baseKey and verifies the payment's
   *  order_id matches, so a spoofed client value can never be trusted. */
  depositOrderId: string;
  /** Captured amount (client claim; the server re-reads it from Square). */
  amountCents: number;
  source: "terminal";
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
//
// CARD-PRESENT (kiosk reader) last-mile — the ONLY correct wiring, do NOT
// mint from a comp discount (that double-books captured cash + a comp):
//   1. Split this into prepare()/finalize() around the async terminal tap.
//   2. prepare(): create the deposit order (step 1 below) → return
//      {depositOrderId, depositLineItemUid}.
//   3. client: createTerminalCheckout({ orderId: depositOrderId, deviceId })
//      (square-terminal.ts already supports orderId) → poll to COMPLETED so
//      the Terminal pays OUR order.
//   4. finalize(): skip authorizeMultiTender (already captured) and run
//      steps 3+4 (activateGiftCardForDeposit) UNCHANGED — the GC stays
//      order+line-item linked exactly like the typed-card path.
// This must ship WITH a live card-present smoke (production Square money
// rail — see the H3074 six-charge lesson). Manual card entry (below) is the
// proven kiosk path until then.

/**
 * Create the single-line deposit order (extracted from createDepositAndCharge so
 * the kiosk direct-Terminal path can create the SAME order — idempotent via
 * `dep-order-${baseKey}` — for the reader to pay, then re-derive it in finalize).
 *
 * `asGiftCardLine` forces `item_type: "GIFT_CARD"`: the typed-card path follows
 * `giftCardSaleEnabled()`, but the Terminal path ALWAYS needs a GIFT_CARD line so
 * the order-linked ACTIVATE (order_id + line_item_uid) can fund the card from the
 * already-captured reader payment. No tax either way — the deposit is already a
 * fraction of the tax-inclusive day-of total.
 */
export async function createDepositOrder(params: {
  baseKey: string;
  locationId: string;
  amountCents: number;
  note: string;
  asGiftCardLine: boolean;
}): Promise<{ depositOrderId: string; depositLineItemUid?: string }> {
  const depositOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `dep-order-${params.baseKey}`,
      order: {
        location_id: params.locationId,
        reference_id: params.note.slice(0, 40),
        line_items: [
          {
            name: DEPOSIT_LINE_ITEM_NAME,
            quantity: "1",
            ...(params.asGiftCardLine ? { item_type: "GIFT_CARD" } : {}),
            base_price_money: { amount: params.amountCents, currency: "USD" },
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
  if (params.asGiftCardLine && !depositLineItemUid) {
    throw new Error("GIFT_CARD deposit order returned no line item uid");
  }
  return { depositOrderId, depositLineItemUid };
}

/**
 * Read a Square payment for server-side verification (kiosk Terminal path). The
 * browser is NEVER trusted for a card-present capture — finalize re-reads the
 * payment to confirm it COMPLETED, paid OUR order, and for the right amount at
 * the right location. Returns null on any fetch error.
 */
export async function getSquarePayment(id: string): Promise<{
  id: string;
  status: string;
  amountCents: number;
  orderId?: string;
  locationId?: string;
} | null> {
  if (!SQUARE_TOKEN) return null;
  try {
    const res = await fetch(`${SQUARE_BASE}/payments/${encodeURIComponent(id)}`, {
      headers: sqHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.payment;
    if (!p?.id) return null;
    return {
      id: p.id,
      status: p.status ?? "UNKNOWN",
      amountCents: p.amount_money?.amount ?? -1,
      orderId: p.order_id,
      locationId: p.location_id,
    };
  } catch {
    return null;
  }
}

/** Payment statuses that will never become COMPLETED — stop polling early. */
const TERMINAL_FAILURE_STATUSES = new Set(["FAILED", "CANCELED"]);

/**
 * getSquarePayment with a short retry for Square's post-checkout propagation
 * lag: a card-present Terminal checkout reports COMPLETED (and hands the client
 * a payment id) a beat before `GET /payments/{id}` reflects it — the read can
 * 404 or come back APPROVED for a second or two while autocomplete captures. A
 * single read therefore rejected a good capture as "unverified" (and reserve
 * throws BEFORE recording it → the guest's money sits captured with no booking).
 * Only COMPLETED is accepted by the caller, so this never weakens the tripwire;
 * it just lets a real capture settle. Bails early on a terminal failure.
 */
export async function getSquarePaymentSettled(
  id: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<Awaited<ReturnType<typeof getSquarePayment>>> {
  const attempts = Math.max(1, opts.attempts ?? 6);
  const delayMs = opts.delayMs ?? 700;
  let last: Awaited<ReturnType<typeof getSquarePayment>> = null;
  for (let i = 0; i < attempts; i++) {
    last = await getSquarePayment(id);
    if (last?.status === "COMPLETED") return last;
    if (last && TERMINAL_FAILURE_STATUSES.has(last.status)) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.error(
    `[deposit] reader payment ${id} not COMPLETED after ${attempts} reads — last status=${last?.status ?? "not-found"}`,
  );
  return last;
}

/**
 * KIOSK DIRECT-TERMINAL finalize — "record the reader payment, do NOT re-charge".
 *
 * The card was already captured on the paired reader against OUR deposit order.
 * This re-derives that order idempotently (dep-order-${baseKey}), verifies the
 * payment server-side (COMPLETED + right order + amount + location — a mismatch
 * throws a paging error and NEVER re-charges), then funds the gift card via the
 * proven order-linked ACTIVATE (same form as giftCardSaleEnabled()). Idempotent
 * via gc-${baseKey} / gc-act-${baseKey}, so re-running reserve with the same
 * externalPayment is a pure no-op replay. There is structurally NO card token
 * here → no double-charge is possible. See tasks/kiosk-terminal-charge.md.
 */
export async function finalizeDepositFromExternalPayment(params: {
  baseKey: string;
  locationId: string;
  amountCents: number; // server-authoritative depositCents
  ganPrefix: string;
  ganSuffix: string;
  note: string;
  externalPaymentId: string;
}): Promise<DepositResult> {
  // 1. Recreate the deposit order idempotently → the SAME id + line uid prepare
  //    created (GIFT_CARD-typed). The client-supplied id is never trusted.
  const { depositOrderId, depositLineItemUid } = await createDepositOrder({
    baseKey: params.baseKey,
    locationId: params.locationId,
    amountCents: params.amountCents,
    note: params.note,
    asGiftCardLine: true,
  });
  if (!depositLineItemUid) {
    throw new Error("terminal deposit order has no GIFT_CARD line uid");
  }

  // 2. Verify the reader payment server-side (never trust the browser).
  const pay = await getSquarePayment(params.externalPaymentId);
  if (!pay || pay.status !== "COMPLETED") {
    throw new TerminalPaymentUnverifiedError("terminal payment not COMPLETED");
  }
  if (pay.orderId && pay.orderId !== depositOrderId) {
    throw new TerminalPaymentUnverifiedError("terminal payment paid a different order");
  }
  if (pay.amountCents !== params.amountCents) {
    throw new TerminalAmountMismatchError(pay.amountCents, params.amountCents);
  }
  if (pay.locationId && pay.locationId !== params.locationId) {
    throw new TerminalPaymentUnverifiedError("terminal payment location mismatch");
  }

  // 3. Fund the gift card from the ALREADY-CAPTURED payment — no charge. Idempotent.
  const { giftCardId, giftCardGan } = await activateGiftCardForDeposit({
    baseKey: params.baseKey,
    locationId: params.locationId,
    amountCents: params.amountCents,
    ganPrefix: params.ganPrefix,
    ganSuffix: params.ganSuffix,
    paymentIds: [params.externalPaymentId],
    depositOrderId,
    lineItemUid: depositLineItemUid, // order-linked form
  });

  console.log(
    `[deposit] terminal finalize depositOrderId=${depositOrderId} amount=${params.amountCents} payment=${params.externalPaymentId}`,
  );
  return {
    depositOrderId,
    depositPaymentId: params.externalPaymentId,
    giftCardId,
    giftCardGan,
    gcApprovedCents: 0,
    cardApprovedCents: params.amountCents,
  };
}

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
  const { depositOrderId, depositLineItemUid } = await createDepositOrder({
    baseKey,
    locationId,
    amountCents,
    note,
    asGiftCardLine: saleMode,
  });

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
  // composeGan guarantees the custom GAN fits Square's 8–20 window (trimming the
  // suffix tail if needed). A GAN that overflowed would fall back to a Square
  // auto-generated numeric gan that isInternalDepositGan can't recognize —
  // making the deposit card redeemable as payment. See lib/gan.ts.
  const { gan: customGan, useCustom: useCustomGan } = composeGan(
    params.ganPrefix,
    params.ganSuffix,
  );
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

/**
 * Kiosk Terminal: the reader payment failed server-side verification (not
 * COMPLETED, wrong order, or wrong location). The money may be captured — the
 * caller must NOT re-charge; it stamps the paymentId on the anchor and pages.
 */
export class TerminalPaymentUnverifiedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TerminalPaymentUnverifiedError";
  }
}

/**
 * Kiosk Terminal: the reader captured a DIFFERENT amount than the server's
 * authoritative deposit (displayed != charged). The funds are captured — recover
 * forward via the terminal-orphan reconcile and page on-call. NEVER re-charge.
 */
export class TerminalAmountMismatchError extends Error {
  chargedCents: number;
  expectedCents: number;
  constructor(chargedCents: number, expectedCents: number) {
    super(`terminal charged ${chargedCents}¢ but server deposit is ${expectedCents}¢`);
    this.name = "TerminalAmountMismatchError";
    this.chargedCents = chargedCents;
    this.expectedCents = expectedCents;
  }
}
