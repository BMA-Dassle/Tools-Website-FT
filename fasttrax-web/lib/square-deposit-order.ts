import { randomUUID } from "crypto";
import {
  getBmiPricing,
  type BmiPricingResult,
  type BmiLineItem,
} from "@/lib/bmi-client";

/**
 * Shared Square deposit gift card layer.
 *
 * Extracted from /api/square/bowling-orders so that ANY bookable item
 * (bowling, laser tag, gel blaster, shuffleboard, duck pin, racing)
 * can create the same 5-step deposit pattern:
 *
 *   1. Day-of order    — full line items + county sales tax, left OPEN.
 *   2. Deposit order   — single deposit line, closed immediately.
 *   3. Deposit payment — charges the card against the deposit order.
 *   4. eGift card      — DIGITAL gift card created.
 *   5. Activate        — sets the gift card balance = charged amount.
 *
 * Both bowling and attractions call these functions;
 * the route handlers are thin parse → call → respond wrappers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Square constants
// ─────────────────────────────────────────────────────────────────────────────

export const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function getSquareToken(): string {
  return process.env.SQUARE_ACCESS_TOKEN || "";
}

export function sqHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getSquareToken()}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/**
 * Location → county sales-tax catalog object.
 *
 *   LAB52GY480CJF (FastTrax Fort Myers)  → Lee County   6.5%
 *   TXBSQN0FEKQ11 (HeadPinz Fort Myers) → Lee County   6.5%
 *   PPTR5G2N0QXF7 (HeadPinz Naples)     → Collier Co.  6.0%
 */
export const LOCATION_TAX: Record<string, string> = {
  LAB52GY480CJF: "UBPQTR3W6ZKVRYFC7DXN2SJN", // FastTrax FM  — Lee County 6.5%
  TXBSQN0FEKQ11: "UBPQTR3W6ZKVRYFC7DXN2SJN", // HeadPinz FM  — Lee County 6.5%
  PPTR5G2N0QXF7: "BQNVIEEZQO2PX2FI72U6FEC4", // HeadPinz NAP — Collier Co. 6.0%
};

export const FRIENDLY_PAYMENT_ERRORS: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
  GENERIC_DECLINE: "Card declined. Please try a different card.",
  INVALID_EXPIRATION: "Card expired. Please use a different card.",
  CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
  CARD_EXPIRED: "Card expired. Please use a different card.",
  CARD_DECLINED: "Card declined. Please try a different card.",
  CARD_DECLINED_VERIFICATION_REQUIRED: "Additional verification required. Please try again.",
  VERIFY_AVS_FAILURE: "Address verification failed. Check your billing zip code and try again.",
  ADDRESS_VERIFICATION_FAILURE: "Address verification failed. Check your billing zip code and try again.",
  CARD_TOKEN_USED_BEFORE: "Payment token already used. Please re-enter your card details.",
  CARD_TOKEN_EXPIRED: "Payment session expired. Please re-enter your card details.",
  INVALID_CARD: "Card number could not be validated. Please check and try again.",
  TRANSACTION_LIMIT: "Transaction limit exceeded. Please try a different card.",
  BAD_EXPIRATION: "Card expiration date is invalid. Please check and try again.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LineItemInput {
  name: string;
  quantity: string;
  catalogObjectId?: string;
  basePriceMoney: { amount: number; currency: "USD" };
  /** Free-text note attached to this line item in Square. */
  note?: string;
  /** Square catalog modifier option IDs. */
  modifiers?: Array<{ catalog_object_id: string }>;
}

export interface DepositOrderResult {
  giftCardId: string | null;
  giftCardGan: string | null;
  depositPaymentId: string | null;
  depositOrderId: string | null;
  dayofOrderId: string;
  depositPaidCents: number;
  dayofTotalCents: number;
  remainingCents: number;
}

export interface QuoteOrderResult {
  dayofOrderId: string;
  dayofTotalCents: number;
  depositCents: number;
}

/**
 * Structured error thrown by createDepositOrder / createQuoteOrder.
 * Route handlers catch this and map to the appropriate HTTP response.
 */
export class DepositOrderError extends Error {
  constructor(
    /** Human-readable message safe to show the customer. */
    public readonly userMessage: string,
    /** Suggested HTTP status code. */
    public readonly statusCode: number,
    /** Square error code (e.g. "INSUFFICIENT_FUNDS"). */
    public readonly code?: string,
    /** Square error detail string. */
    public readonly detail?: string,
  ) {
    super(userMessage);
    this.name = "DepositOrderError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build Square line_items array from our LineItemInput[] shape. */
function buildSquareLineItems(lineItems: LineItemInput[]) {
  return lineItems.map((li) => {
    const modifiers =
      li.modifiers?.length
        ? { applied_modifiers: li.modifiers.map((m) => ({ catalog_object_id: m.catalog_object_id })) }
        : {};
    const noteField = li.note ? { note: li.note } : {};
    if (li.catalogObjectId) {
      return { catalog_object_id: li.catalogObjectId, quantity: li.quantity, ...modifiers, ...noteField };
    }
    return {
      name: li.name,
      quantity: li.quantity,
      base_price_money: li.basePriceMoney,
      ...modifiers,
      ...noteField,
    };
  });
}

/** Attach squareCustomerId to an existing order (fallback when quote didn't set it). */
async function linkCustomerToOrder(dayofOrderId: string, locationId: string, squareCustomerId: string): Promise<void> {
  try {
    const getRes = await fetch(`${SQUARE_BASE}/orders/${dayofOrderId}`, { headers: sqHeaders() });
    if (!getRes.ok) {
      console.warn(`[square-deposit] Failed to GET order ${dayofOrderId}: ${getRes.status}`);
      return;
    }
    const getData = await getRes.json();
    const existingCustId = getData.order?.customer_id;
    const version = getData.order?.version;
    if (!existingCustId && version != null) {
      const putRes = await fetch(`${SQUARE_BASE}/orders/${dayofOrderId}`, {
        method: "PUT",
        headers: sqHeaders(),
        body: JSON.stringify({
          order: { location_id: locationId, customer_id: squareCustomerId, version },
        }),
      });
      if (!putRes.ok) {
        const putErr = await putRes.json().catch(() => ({}));
        console.warn(`[square-deposit] Failed to link customer ${squareCustomerId} to order ${dayofOrderId}:`, putErr);
      }
    }
  } catch (err) {
    console.warn(`[square-deposit] customer link error for ${dayofOrderId}:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createQuoteOrder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Square day-of order (no payment) and returns the tax-inclusive
 * total + computed deposit amount.
 *
 * Called by the review step so the UI shows the exact charge including tax
 * before the customer enters their card.
 *
 * @throws {DepositOrderError}
 */
export async function createQuoteOrder(opts: {
  locationId: string;
  lineItems: LineItemInput[];
  depositPct?: number;
  squareCustomerId?: string;
  /** Idempotency key prefix — defaults to random UUID. */
  idempotencyKey?: string;
}): Promise<QuoteOrderResult> {
  const { locationId, lineItems, depositPct = 100, squareCustomerId } = opts;
  const baseKey = opts.idempotencyKey ?? randomUUID();

  const taxCatalogId = LOCATION_TAX[locationId];
  const orderTaxes = taxCatalogId
    ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
    : [];

  const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `quote-${baseKey}`,
      order: {
        location_id: locationId,
        ...(squareCustomerId ? { customer_id: squareCustomerId } : {}),
        line_items: buildSquareLineItems(lineItems),
        ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
      },
    }),
  });

  const orderData = await orderRes.json();
  if (!orderRes.ok || orderData.errors) {
    const sqErr = orderData.errors?.[0];
    const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(orderData);
    console.error("[square-deposit/quote] Square order failed:", detail);
    throw new DepositOrderError(`Square order failed: ${detail}`, 500);
  }

  const dayofOrderId: string = orderData.order?.id;
  const dayofTotalCents: number = orderData.order?.total_money?.amount ?? 0;
  const depositCents = Math.round((dayofTotalCents * depositPct) / 100);

  return { dayofOrderId, dayofTotalCents, depositCents };
}

// ─────────────────────────────────────────────────────────────────────────────
// createDepositOrder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full 5-step deposit flow: day-of order → deposit order → payment →
 * gift card → activation.
 *
 * For $0 bookings (depositCents === 0): skips steps 2–5 and returns
 * null gift card + payment IDs.
 *
 * @throws {DepositOrderError}
 */
export async function createDepositOrder(opts: {
  sourceId: string;
  idempotencyKey?: string;
  locationId: string;
  depositPct?: number;
  lineItems?: LineItemInput[];
  squareCustomerId?: string;
  note?: string;
  giftCardGan?: string;
  existingDayofOrderId?: string;
  existingDayofTotalCents?: number;
  existingDepositCents?: number;
  /**
   * Name for the single line item on the deposit order.
   * Defaults to "Bowling Reservation Deposit".
   * Use e.g. "Laser Tag Deposit" for attractions.
   */
  depositLineName?: string;
}): Promise<DepositOrderResult> {
  const {
    sourceId,
    locationId,
    lineItems,
    squareCustomerId,
    note,
    depositLineName = "Bowling Reservation Deposit",
  } = opts;
  const depositPct = opts.depositPct ?? 100;
  const baseKey = opts.idempotencyKey ?? randomUUID();

  const taxCatalogId = LOCATION_TAX[locationId];
  const orderTaxes = taxCatalogId
    ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
    : [];

  // ── Step 1: Day-of order (full line items + tax, left OPEN) ──────────────
  let dayofOrderId: string;
  let dayofTotalCents: number;

  if (opts.existingDayofOrderId && opts.existingDayofTotalCents != null) {
    dayofOrderId = opts.existingDayofOrderId;
    dayofTotalCents = opts.existingDayofTotalCents;

    // Attach loyalty customer if quote didn't set it
    if (squareCustomerId) {
      await linkCustomerToOrder(dayofOrderId, locationId, squareCustomerId);
    }
  } else {
    if (!lineItems?.length) {
      throw new DepositOrderError("lineItems required when no existing day-of order", 400);
    }
    const dayofOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `dayof-${baseKey}`,
        order: {
          location_id: locationId,
          ...(squareCustomerId ? { customer_id: squareCustomerId } : {}),
          line_items: buildSquareLineItems(lineItems),
          ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
        },
      }),
    });
    const dayofOrderData = await dayofOrderRes.json();

    if (!dayofOrderRes.ok || dayofOrderData.errors) {
      const sqErr = dayofOrderData.errors?.[0];
      const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(dayofOrderData);
      console.error("[square-deposit] day-of order failed:", detail);
      throw new DepositOrderError(`Failed to create day-of order: ${detail}`, 500);
    }

    dayofOrderId = dayofOrderData.order?.id as string;
    if (!dayofOrderId) {
      throw new DepositOrderError("Day-of order returned no ID", 500);
    }
    dayofTotalCents = (dayofOrderData.order?.total_money?.amount as number) ?? 0;
  }

  const depositCents =
    opts.existingDepositCents != null
      ? opts.existingDepositCents
      : Math.round((dayofTotalCents * depositPct) / 100);

  // ── $0 bookings: no charge, no gift card ─────────────────────────────────
  if (depositCents <= 0) {
    return {
      giftCardId: null,
      giftCardGan: null,
      depositPaymentId: null,
      depositOrderId: null,
      dayofOrderId,
      depositPaidCents: 0,
      dayofTotalCents,
      remainingCents: dayofTotalCents,
    };
  }

  // ── Step 2: Deposit order (single line, closed at payment) ───────────────
  const depositOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `dep-${baseKey}`,
      order: {
        location_id: locationId,
        reference_id: note ? note.slice(0, 40) : undefined,
        line_items: [
          {
            name: depositLineName,
            quantity: "1",
            base_price_money: { amount: depositCents, currency: "USD" },
          },
        ],
      },
    }),
  });
  const depositOrderData = await depositOrderRes.json();

  if (!depositOrderRes.ok || depositOrderData.errors) {
    const sqErr = depositOrderData.errors?.[0];
    const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(depositOrderData);
    console.error("[square-deposit] deposit order failed:", detail);
    throw new DepositOrderError(`Failed to create deposit order: ${detail}`, 500);
  }

  const depositOrderId: string = depositOrderData.order?.id as string;
  if (!depositOrderId) {
    throw new DepositOrderError("Deposit order returned no ID", 500);
  }

  // ── Step 3: Charge card against deposit order ────────────────────────────
  const paymentBody: Record<string, unknown> = {
    source_id: sourceId,
    idempotency_key: `pay-${baseKey}`,
    amount_money: { amount: depositCents, currency: "USD" },
    location_id: locationId,
    order_id: depositOrderId,
    autocomplete: true,
    note: note ?? "Deposit",
  };
  if (squareCustomerId) paymentBody.customer_id = squareCustomerId;

  const payRes = await fetch(`${SQUARE_BASE}/payments`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify(paymentBody),
  });
  const payData = await payRes.json();

  if (!payRes.ok || payData.errors) {
    const sqErr = payData.errors?.[0];
    const code: string = sqErr?.code ?? "UNKNOWN";
    const detail: string = sqErr?.detail ?? "Payment failed";
    console.error("[square-deposit] payment failed:", code, detail);
    throw new DepositOrderError(
      FRIENDLY_PAYMENT_ERRORS[code] ?? "Payment could not be processed. Please try again.",
      400,
      code,
      detail,
    );
  }

  const depositPaymentId: string = payData.payment?.id;
  if (!depositPaymentId) {
    throw new DepositOrderError("Payment succeeded but returned no ID", 500);
  }

  // ── Step 4: Create eGift card ────────────────────────────────────────────
  const customGan = opts.giftCardGan?.replace(/[^A-Za-z0-9]/g, "");
  const useCustomGan = customGan && customGan.length >= 8 && customGan.length <= 20;
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
    console.error("[square-deposit] gift card creation failed:", detail);
    throw new DepositOrderError(`Payment captured but gift card creation failed: ${detail}`, 500);
  }

  const giftCardId: string = giftCardData.gift_card?.id;
  const giftCardGan: string = giftCardData.gift_card?.gan;
  if (!giftCardId || !giftCardGan) {
    throw new DepositOrderError("Gift card creation returned no ID or GAN", 500);
  }

  // ── Step 5: Activate gift card (PENDING → ACTIVE, sets balance) ──────────
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
          amount_money: { amount: depositCents, currency: "USD" },
          buyer_payment_instrument_ids: [depositPaymentId],
        },
      },
    }),
  });
  const activateData = await activateRes.json();

  if (!activateRes.ok || activateData.errors) {
    const sqErr = activateData.errors?.[0];
    const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(activateData);
    console.error("[square-deposit] gift card activation failed:", detail);
    throw new DepositOrderError(`Payment captured but gift card activation failed: ${detail}`, 500);
  }

  return {
    giftCardId,
    giftCardGan,
    depositPaymentId,
    depositOrderId,
    dayofOrderId,
    depositPaidCents: depositCents,
    dayofTotalCents,
    remainingCents: dayofTotalCents - depositCents,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// syncBmiToSquareOrder — BMI-as-pricing-authority helper for racing
// ─────────────────────────────────────────────────────────────────────────────

export { getBmiPricing, type BmiPricingResult, type BmiLineItem };

/**
 * Result of syncing BMI pricing to a Square order.
 * Extends BmiPricingResult with the Square order IDs.
 */
export interface SyncBmiSquareResult extends BmiPricingResult {
  /** Square day-of order ID (created or updated). Undefined for credit-only / $0 orders. */
  dayofOrderId?: string;
  /** Square order version (for subsequent updates). */
  dayofOrderVersion?: number;
}

/**
 * Reads BMI bill/overview (via getBmiPricing) and creates or updates a
 * Square day-of order to match the BMI cash total. Attaches metadata
 * to the Square order for audit trail (bmi_bill_id, credit info, etc.).
 *
 * For credit-only or $0 orders, no Square order is created — returns
 * the BMI pricing data with no dayofOrderId.
 *
 * Used by the standalone racing reserve endpoint. The unified checkout
 * should call getBmiPricing() directly and merge with QAMF items before
 * creating a single combined Square order.
 */
export async function syncBmiToSquareOrder(opts: {
  bmiBillId: string;
  bmiClientKey: string;
  locationId: string;
  /** Reuse an existing quote order instead of creating a new one. */
  existingDayofOrderId?: string;
  note?: string;
  /** Square order metadata (up to 10 key-value pairs, 60c keys / 255c values). */
  metadata?: Record<string, string>;
  squareCustomerId?: string;
}): Promise<SyncBmiSquareResult> {
  const { bmiBillId, bmiClientKey, locationId } = opts;

  // ── Step 1: Get authoritative pricing from BMI ──────────────────────
  const pricing = await getBmiPricing({ bmiBillId, bmiClientKey });

  console.log(
    `[syncBmiToSquare] BMI pricing: cash=${pricing.cashOwedCents}c ` +
    `credit=${pricing.creditAppliedCents}c total=${pricing.bmiTotalCents}c ` +
    `items=${pricing.lineItems.length} ` +
    `creditOnly=${pricing.isCreditOnly} zeroDollar=${pricing.isZeroDollar}`,
  );

  // ── Credit-only or $0: no Square order needed ────────────────────────
  if (pricing.isCreditOnly || pricing.isZeroDollar) {
    return { ...pricing };
  }

  // ── Step 2: Build Square line items from BMI ────────────────────────
  const sqLineItems = pricing.lineItems.map((li) => ({
    name: li.name,
    quantity: String(li.quantity),
    base_price_money: { amount: li.unitPriceCents, currency: "USD" },
  }));

  const taxCatalogId = LOCATION_TAX[locationId];
  const orderTaxes = taxCatalogId
    ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
    : [];

  const metadataField = opts.metadata && Object.keys(opts.metadata).length > 0
    ? { metadata: opts.metadata }
    : {};

  // ── Step 3: Create or update Square order ────────────────────────────
  let dayofOrderId: string;
  let dayofOrderVersion: number;

  if (opts.existingDayofOrderId) {
    // Update existing order: GET → PUT with new line items + metadata
    const getRes = await fetch(`${SQUARE_BASE}/orders/${opts.existingDayofOrderId}`, {
      headers: sqHeaders(),
    });
    if (!getRes.ok) {
      throw new DepositOrderError(
        `Failed to fetch existing order: ${getRes.status}`,
        500,
      );
    }
    const getData = await getRes.json();
    const version = getData.order?.version;

    const putRes = await fetch(`${SQUARE_BASE}/orders/${opts.existingDayofOrderId}`, {
      method: "PUT",
      headers: sqHeaders(),
      body: JSON.stringify({
        order: {
          location_id: locationId,
          version,
          line_items: sqLineItems,
          ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
          ...(opts.squareCustomerId ? { customer_id: opts.squareCustomerId } : {}),
          ...metadataField,
        },
      }),
    });
    const putData = await putRes.json();
    if (!putRes.ok || putData.errors) {
      const sqErr = putData.errors?.[0];
      const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(putData);
      throw new DepositOrderError(`Failed to update Square order: ${detail}`, 500);
    }

    dayofOrderId = opts.existingDayofOrderId;
    dayofOrderVersion = putData.order?.version ?? version + 1;
  } else {
    // Create new order
    const baseKey = randomUUID();
    const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `bmi-sync-${baseKey}`,
        order: {
          location_id: locationId,
          ...(opts.squareCustomerId ? { customer_id: opts.squareCustomerId } : {}),
          line_items: sqLineItems,
          ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
          ...metadataField,
        },
      }),
    });
    const orderData = await orderRes.json();
    if (!orderRes.ok || orderData.errors) {
      const sqErr = orderData.errors?.[0];
      const detail = sqErr ? `${sqErr.code}: ${sqErr.detail}` : JSON.stringify(orderData);
      throw new DepositOrderError(`Failed to create Square order: ${detail}`, 500);
    }

    dayofOrderId = orderData.order?.id;
    dayofOrderVersion = orderData.order?.version ?? 1;
  }

  console.log(
    `[syncBmiToSquare] Square order ${dayofOrderId} (v${dayofOrderVersion}) ` +
    `synced to BMI bill ${bmiBillId}`,
  );

  return {
    ...pricing,
    dayofOrderId,
    dayofOrderVersion,
  };
}
