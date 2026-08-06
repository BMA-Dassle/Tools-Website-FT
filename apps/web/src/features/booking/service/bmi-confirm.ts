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

/** Liveness + outstanding MONEY deposit of a BMI bill, from one overview GET. */
export interface BmiBillStatus {
  /** ≥1 line item still on the bill (false = auto-cancelled / gone). */
  live: boolean;
  /**
   * BMI's own `totalToDeposit` — the money (kind 0) deposit still OWED on the
   * bill, in cents. 0 on a satisfied bill. null when the overview didn't carry
   * the field (callers fall back to their own computation). Race $0-model lines
   * deposit in credits, which BMI does NOT count here — so on a mixed bill this
   * is exactly the attraction lines' unpaid money.
   */
  moneyDueCents: number | null;
}

/**
 * Re-fetch a BMI bill's order overview: is it still live, and how much money
 * deposit does BMI still want on it?
 *
 * BMI auto-cancels a Pending-Online hold after the center's auto-cancel timeout,
 * which STRIPS the bill's products/schedule. If that happens during a customer's
 * dwell, a later payment/confirm returns status 4 ("BillNotFound") — but only
 * AFTER the card has been charged on Square. Calling this BEFORE any charge lets
 * us refuse to take money for a reservation that no longer exists.
 *
 * `moneyDueCents` exists for the MIXED-cart confirm (races + BMI-priced
 * attraction on one bill): since BMI flipped the Nexus attraction products to
 * require a money deposit (~2026-07-22), a bill confirmed as a $0 credit keeps
 * `totalToDeposit` outstanding and BMI later releases the unpaid lines'
 * SCHEDULES — the guest vanishes off the arena dayplanner (W57040/W56953,
 * 2026-08-01). The confirm must pay exactly what BMI says is owed.
 *
 * Read-only. The overview carries a 17-digit orderId, so it's parsed lossless
 * (parseWithRawIds / regex) — never use Number()/JSON.parse on a BMI
 * id-bearing response.
 */
export async function getBmiBillStatus(clientKey: string, billId: string): Promise<BmiBillStatus> {
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
  // A clean 404 means the bill is gone (definitely not live). Pandora also
  // answers 400 "Entity Bill not found by key = …" when the bill doesn't exist
  // in THIS center's BMI (e.g. it was created against the other center) — that
  // is just as definitive, so report not-live rather than failing open. Other
  // non-OK statuses throw so the caller can decide (it fails open — a transient
  // BMI error must never block a legitimate paying customer).
  if (!res.ok) {
    if (res.status === 404) return { live: false, moneyDueCents: null };
    const body = await res.text().catch(() => "");
    if (res.status === 400 && /not found/i.test(body)) return { live: false, moneyDueCents: null };
    throw new Error(`BMI bill overview failed: ${res.status}`);
  }
  const text = await res.text();
  const ov = parseWithRawIds<{ lines?: unknown[] }>(text);
  const live = Array.isArray(ov.lines) && ov.lines.length > 0;
  // Regex on raw text (id-precision rule); totalToDeposit is a plain decimal.
  const due = text.match(/"totalToDeposit"\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)/);
  const moneyDueCents = due ? Math.max(0, Math.round(parseFloat(due[1]) * 100)) : null;
  return { live, moneyDueCents };
}

/** Liveness only — see getBmiBillStatus (same fetch, same semantics). */
export async function bmiBillIsLive(clientKey: string, billId: string): Promise<boolean> {
  return (await getBmiBillStatus(clientKey, billId)).live;
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

  // BMI answers HTTP 200 with a status-only body (status 4 = BillNotFound) when
  // the bill doesn't exist in this center — e.g. a bill created in the OTHER
  // center's BMI. Every genuine confirm returns a reservationNumber (2,271 of
  // 2,271 healthy rows carry one), so a missing number means the confirm did
  // not land anywhere: fail loudly instead of marking the booking confirmed.
  // Regex on raw text — never JSON.parse an id-bearing BMI response.
  const reservationNumber = bmiText.match(/"reservationNumber"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const reservationCode = bmiText.match(/"reservationCode"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  if (!reservationNumber) {
    throw new Error(`BMI payment/confirm returned no reservationNumber: ${bmiText.slice(0, 200)}`);
  }
  return { reservationNumber, reservationCode };
}
