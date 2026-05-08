import redis from "@/lib/redis";

/**
 * QubicaAMF Bowling API OAuth2 client_credentials helper.
 *
 * Mints + caches the Bearer token used to call
 *   https://api.qubicaamf.com/bowling-reservations/*
 *
 * Per QubicaAMF official specs (oauth2-0.yaml + bowling-reservations.yaml):
 *
 *   Token mint  — POST https://api.qubicaamf.com/oauth2/token
 *                   Access-Key: <QAMF_BOWLING_ACCESS_KEY>        ← required by oauth2 spec
 *                   Content-Type: application/json
 *                   body: { client_id, client_secret, grant_type }
 *
 *   API calls   — Authorization: Bearer <token>
 *                   Ocp-Apim-Subscription-Key: <QAMF_BOWLING_SUBSCRIPTION_KEY>  ← required
 *                   api-version: 2025-12-01.1.0
 *
 * Env vars (set on Vercel):
 *   QAMF_BOWLING_CLIENT_ID           — required
 *   QAMF_BOWLING_CLIENT_SECRET       — required
 *   QAMF_BOWLING_ACCESS_KEY          — required (sent as Access-Key on token mint)
 *   QAMF_BOWLING_SUBSCRIPTION_KEY    — required (sent as Ocp-Apim-Subscription-Key on API calls)
 *   QAMF_BOWLING_WEBHOOK_SECRET      — optional (for webhook HMAC validation)
 */

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const CACHE_KEY = "qamf:bowling:access-token";
// Cache for 23h — tokens come back as expires_in: 86399 (~24h).
const CACHE_TTL_SECONDS = 60 * 60 * 23;

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}

async function mintToken(): Promise<string> {
  const clientId = process.env.QAMF_BOWLING_CLIENT_ID;
  const clientSecret = process.env.QAMF_BOWLING_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QAMF_BOWLING_CLIENT_ID / QAMF_BOWLING_CLIENT_SECRET not set");
  }

  const accessKey = process.env.QAMF_BOWLING_ACCESS_KEY;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessKey) headers["Access-Key"] = accessKey;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`qamf-bowling token mint failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as TokenResponse;
  if (!json?.access_token || typeof json.access_token !== "string") {
    throw new Error("qamf-bowling token mint returned no access_token");
  }
  await redis.set(CACHE_KEY, json.access_token, "EX", CACHE_TTL_SECONDS);
  return json.access_token;
}

/** Get a valid Bearer token. Cached in Redis; re-mints on cache miss. */
export async function getQamfBowlingToken(): Promise<string> {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return cached;
  return mintToken();
}

/** Force-evict the cached token (call after a 401 before retrying). */
export async function invalidateQamfBowlingToken(): Promise<void> {
  await redis.del(CACHE_KEY);
}

/**
 * Returns the Ocp-Apim-Subscription-Key for bowling-reservations API calls.
 * Required on every request per the official OpenAPI spec.
 */
export function getQamfSubscriptionKey(): string {
  return process.env.QAMF_BOWLING_SUBSCRIPTION_KEY ?? "";
}

/**
 * Wrapper that runs a fetch closure with a fresh Bearer token + subscription
 * key, retries once on 401 with a re-minted token.
 *
 * Usage:
 *   const res = await qamfAuthedFetch(
 *     (token, subKey) => fetch(`${BOWLING_BASE}/centers/${id}/lanes`, {
 *       headers: {
 *         authorization: `Bearer ${token}`,
 *         "Ocp-Apim-Subscription-Key": subKey,
 *         "api-version": "2025-12-01.1.0",
 *       },
 *     }),
 *     "getLanes",
 *   );
 */
export async function qamfAuthedFetch(
  doFetch: (token: string, subscriptionKey: string) => Promise<Response>,
  errLabel: string,
): Promise<Response> {
  const subKey = getQamfSubscriptionKey();
  let token = await getQamfBowlingToken();
  let res = await doFetch(token, subKey);
  if (res.status === 401 || res.status === 403) {
    await invalidateQamfBowlingToken();
    token = await mintToken();
    res = await doFetch(token, subKey);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`qamf-bowling ${errLabel} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res;
}
