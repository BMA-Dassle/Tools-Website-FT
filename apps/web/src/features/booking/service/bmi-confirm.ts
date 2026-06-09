/**
 * BMI payment/confirm — extracted from /api/booking/v2/reserve.
 *
 * Confirms a BMI bill as paid (or as a $0 credit). Server-side only.
 * Uses raw string injection for orderId to preserve bigint precision.
 */

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
