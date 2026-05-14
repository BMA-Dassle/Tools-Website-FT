/**
 * Shared BMI Public Booking API client.
 *
 * Centralises auth (token cache) and bill/overview parsing so that
 * attractions/v2/reserve, checkout/v2, and racing/v2/reserve all
 * share a single implementation instead of copy-pasting.
 *
 * CRITICAL: BMI bill/order IDs exceed Number.MAX_SAFE_INTEGER.
 *   → All IDs are strings, NEVER coerced via Number() or JSON.stringify().
 *   → Use raw-text JSON injection for request bodies containing orderId.
 */

// ── Config ─────────────────────────────────────────────────────────────────

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

export const ALLOWED_BMI_CLIENTS = new Set(["headpinzftmyers", "headpinznaples"]);

export const LOCATION_TO_BMI_CLIENT: Record<string, string> = {
  fasttrax: "headpinzftmyers",
  headpinz: "headpinzftmyers",
  naples: "headpinznaples",
};

// ── Token cache ────────────────────────────────────────────────────────────

const tokenCache: Record<string, { token: string; expiry: number }> = {};

export async function getBmiToken(clientKey: string): Promise<string> {
  const cached = tokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;

  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BMI-Subscription-Key": BMI_SUB_KEY,
    },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`BMI auth failed: ${res.status}`);

  const data = await res.json();
  const token = data.AccessToken || data.accessToken;
  const expiresIn = parseInt(data.ExpiresIn || data.expiresIn || "3600", 10);
  tokenCache[clientKey] = { token, expiry: Date.now() + expiresIn * 1000 };
  return token;
}

export function bmiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "BMI-Subscription-Key": BMI_SUB_KEY,
    "Content-Type": "application/json",
    "Accept-Language": "en",
  };
}

// ── BMI payment/confirm helper ─────────────────────────────────────────────

export interface BmiConfirmResult {
  confirmed: boolean;
  reservationNumber?: string;
  rawResponse: string;
}

/**
 * Confirm a BMI bill/order. Uses raw JSON injection to preserve orderId precision.
 *
 * @param depositKind - 0 for cash, 2 for credit-only
 */
export async function confirmBmiPayment(opts: {
  clientKey: string;
  bmiBillId: string;
  depositKind: 0 | 2;
}): Promise<BmiConfirmResult> {
  const { clientKey, bmiBillId, depositKind } = opts;
  const token = await getBmiToken(clientKey);
  const confirmUrl = `${BMI_API_URL}/public-booking/${clientKey}/payment/confirm`;
  const confirmId = crypto.randomUUID();
  const confirmTime = new Date().toISOString();

  // Raw JSON — orderId injected as raw number string for 18-digit precision
  const confirmBody = `{"id":"${confirmId}","paymentTime":"${confirmTime}","amount":0,"orderId":${bmiBillId},"depositKind":${depositKind}}`;

  console.log(`[bmi-client] payment/confirm: ${confirmBody.substring(0, 200)}`);

  const res = await fetch(confirmUrl, {
    method: "POST",
    headers: bmiHeaders(token),
    body: confirmBody,
    cache: "no-store",
  });

  const raw = await res.text();
  console.log(`[bmi-client] confirm response: ${res.status} ${raw.substring(0, 300)}`);

  if (!res.ok) {
    return { confirmed: false, rawResponse: raw };
  }

  const rnMatch = raw.match(/"reservationNumber"\s*:\s*"([^"]+)"/);
  return {
    confirmed: true,
    reservationNumber: rnMatch?.[1],
    rawResponse: raw,
  };
}

// ── Bill/overview pricing ──────────────────────────────────────────────────

/**
 * A line item from BMI bill/overview, normalised for Square order creation.
 */
export interface BmiLineItem {
  name: string;
  quantity: number;
  /** Cash unit price in cents (depositKind:0 total ÷ quantity). */
  unitPriceCents: number;
  /** Total cash price for this line in cents (pre-tax). */
  totalCashCents: number;
  /** Tax on this line in cents. */
  taxCents: number;
  /** BMI line ID (as string — precision-safe). */
  lineId?: string;
  /** BMI product group (e.g. "Karting"). */
  productGroup?: string;
  /** Scheduled time for this line (ISO 8601). */
  scheduledTime?: string;
}

export interface BmiPricingResult {
  /** Total cash owed in cents (sum of depositKind:0 totals, minus skipped items). */
  cashOwedCents: number;
  /** Subtotal (cash, before tax) in cents. */
  cashSubtotalCents: number;
  /** Tax (cash portion) in cents. */
  cashTaxCents: number;
  /** Total credits applied in cents (absolute value of depositKind:2 entries). */
  creditAppliedCents: number;
  /** Full BMI total before credits (cash + credits). */
  bmiTotalCents: number;
  /** Parsed line items (membership license excluded). */
  lineItems: BmiLineItem[];
  /** True if fully covered by credits ($0 cash, credits > 0). */
  isCreditOnly: boolean;
  /** True if $0 total with no credits (free promo). */
  isZeroDollar: boolean;
}

/** Auto-added membership license: kind=3, productId 11253570. Always skip. */
const AUTO_MEMBERSHIP_PRODUCT_ID = "11253570";

/**
 * Read BMI bill/overview and return structured pricing.
 *
 * Pure data function — no Square calls. Reusable by:
 *   - standalone racing reserve (syncBmiToSquareOrder)
 *   - unified checkout (merge with QAMF items)
 *   - any future flow that needs BMI pricing
 */
export async function getBmiPricing(opts: {
  bmiBillId: string;
  bmiClientKey: string;
}): Promise<BmiPricingResult> {
  const { bmiBillId, bmiClientKey } = opts;
  const token = await getBmiToken(bmiClientKey);

  const overviewUrl =
    `${BMI_API_URL}/public-booking/${bmiClientKey}/bill/overview?billId=${bmiBillId}`;

  const res = await fetch(overviewUrl, {
    headers: bmiHeaders(token),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`BMI bill/overview failed: ${res.status} ${text.substring(0, 200)}`);
  }

  const overview = await res.json();

  // ── Top-level totals (arrays keyed by depositKind) ──────────────────
  const cashTotal = overview.total?.find(
    (t: { depositKind: number }) => t.depositKind === 0,
  )?.amount ?? 0;
  const cashSub = overview.subTotal?.find(
    (t: { depositKind: number }) => t.depositKind === 0,
  )?.amount ?? 0;
  const cashTax = overview.totalTax?.find(
    (t: { depositKind: number }) => t.depositKind === 0,
  )?.amount ?? 0;

  // Credits may have MULTIPLE depositKind:2 entries — sum them all
  const creditTotals = (overview.total || []).filter(
    (t: { depositKind: number }) => t.depositKind === 2,
  );
  const creditApplied = creditTotals.reduce(
    (sum: number, ct: { amount: number }) => sum + Math.abs(ct.amount),
    0,
  );

  // ── Parse line items, filtering out auto-added membership ───────────
  let cashOwedCents = cashTotal;
  let cashSubtotalCents = cashSub;
  let cashTaxCents = cashTax;
  const lineItems: BmiLineItem[] = [];

  for (const l of overview.lines || []) {
    // Skip BMI auto-added membership license (kind=3, productId 11253570)
    // Our intentional Racing License (productId 43473520, kind=1) is kept.
    if (l.kind === 3 && String(l.productId) === AUTO_MEMBERSHIP_PRODUCT_ID) {
      const memPrice =
        l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0)?.amount ?? 0;
      const memTax = l.totalTax ?? 0;
      cashOwedCents -= (memPrice + memTax);
      cashSubtotalCents -= memPrice;
      cashTaxCents -= memTax;
      console.log(
        `[bmi-client] Skipping auto-membership: ${l.name} (${memPrice + memTax}c)`,
      );
      continue;
    }

    const cashPrice =
      l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0)?.amount ?? 0;
    const lineTax = l.totalTax ?? 0;
    const qty = l.quantity ?? 1;
    const scheduledTime =
      l.scheduledTime?.start || l.schedules?.[0]?.start || undefined;

    lineItems.push({
      name: l.name,
      quantity: qty,
      unitPriceCents: qty > 0 ? Math.round(cashPrice / qty) : cashPrice,
      totalCashCents: cashPrice,
      taxCents: lineTax,
      lineId: l.id != null ? String(l.id) : undefined,
      productGroup: l.productGroup || undefined,
      scheduledTime,
    });
  }

  const bmiTotalCents = cashOwedCents + creditApplied;
  const isCreditOnly = cashOwedCents === 0 && creditApplied > 0;
  const isZeroDollar = cashOwedCents === 0 && creditApplied === 0;

  return {
    cashOwedCents,
    cashSubtotalCents,
    cashTaxCents,
    creditAppliedCents: creditApplied,
    bmiTotalCents,
    lineItems,
    isCreditOnly,
    isZeroDollar,
  };
}
