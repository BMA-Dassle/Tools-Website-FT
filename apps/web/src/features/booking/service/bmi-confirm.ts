/**
 * BMI payment/confirm — extracted from /api/booking/v2/reserve.
 *
 * Confirms a BMI bill as paid (or as a $0 credit). Server-side only.
 * Uses raw string injection for orderId to preserve bigint precision.
 */

import { parseWithRawIds } from "@ft/db";

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

const tokenCache: Record<string, { token: string; expiry: number }> = {};

async function getBmiToken(clientKey: string): Promise<string> {
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

/**
 * Re-fetch a BMI bill's order overview to confirm it still holds live products.
 *
 * BMI auto-cancels a Pending-Online hold after the center's auto-cancel timeout,
 * which STRIPS the bill's products/schedule. If that happens during a customer's
 * dwell, a later payment/confirm returns status 4 ("BillNotFound") — but only
 * AFTER the card has been charged on Square. Calling this BEFORE any charge lets
 * us refuse to take money for a reservation that no longer exists.
 *
 * Returns true when the bill still has ≥1 line item; false when it's empty /
 * auto-cancelled / gone (404). Read-only. The overview carries a 17-digit
 * orderId, so it's parsed lossless (parseWithRawIds) even though we only read
 * array lengths — never use Number()/JSON.parse on a BMI id-bearing response.
 */
export async function bmiBillIsLive(clientKey: string, billId: string): Promise<boolean> {
  const token = await getBmiToken(clientKey);
  const url = `${BMI_API_URL}/public-booking/${clientKey}/order/${billId}/overview`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "BMI-Subscription-Key": BMI_SUB_KEY,
      "Accept-Language": "en",
    },
    cache: "no-store",
  });
  // A clean 404 means the bill is gone (definitely not live). Other non-OK
  // statuses throw so the caller can decide (it fails open — a transient BMI
  // error must never block a legitimate paying customer).
  if (!res.ok) {
    if (res.status === 404) return false;
    throw new Error(`BMI bill overview failed: ${res.status}`);
  }
  const ov = parseWithRawIds<{ lines?: unknown[] }>(await res.text());
  return Array.isArray(ov.lines) && ov.lines.length > 0;
}

export interface BmiConfirmInput {
  clientKey: string;
  bmiBillId: string;
  amountCents: number;
  asCredit: boolean;
}

export interface BmiConfirmResult {
  reservationNumber: string | null;
  reservationCode: string | null;
}

export async function confirmBmiPayment(input: BmiConfirmInput): Promise<BmiConfirmResult> {
  const { clientKey, bmiBillId, amountCents, asCredit } = input;

  const token = await getBmiToken(clientKey);
  const paymentTime = new Date().toISOString();

  // Raw string injection — orderId is a 17-digit bigint, NEVER use Number()
  const bmiBody = asCredit
    ? `{"id":"${crypto.randomUUID()}","paymentTime":"${paymentTime}","amount":0,"orderId":${bmiBillId},"depositKind":2}`
    : `{"id":"${crypto.randomUUID()}","paymentTime":"${paymentTime}","amount":${amountCents / 100},"orderId":${bmiBillId},"depositKind":0}`;

  const bmiUrl = `${BMI_API_URL}/public-booking/${clientKey}/payment/confirm`;

  const bmiRes = await fetch(bmiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "BMI-Subscription-Key": BMI_SUB_KEY,
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: bmiBody,
    cache: "no-store",
  });

  const bmiText = await bmiRes.text();
  if (!bmiRes.ok) {
    throw new Error(`BMI payment/confirm failed: ${bmiRes.status} ${bmiText.slice(0, 200)}`);
  }

  const bmiData = JSON.parse(bmiText);
  return {
    reservationNumber: bmiData.reservationNumber ?? null,
    reservationCode: bmiData.reservationCode ?? null,
  };
}
