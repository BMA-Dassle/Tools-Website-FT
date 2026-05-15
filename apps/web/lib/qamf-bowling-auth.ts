import redis from "@/lib/redis";

/**
 * QubicaAMF Bowling API OAuth2 client_credentials helper.
 *
 * Mints + caches the Bearer token used to call
 *   https://api.qubicaamf.com/bowling-reservations/*
 *
 * Auth flow (confirmed working 2026-05-08):
 *
 *   Token mint  — POST https://api.qubicaamf.com/oauth2/token
 *                   Content-Type: application/x-www-form-urlencoded   ← MUST be form-encoded, not JSON
 *                   body: grant_type=client_credentials
 *                         &client_id=BMA
 *                         &client_secret=<secret>
 *                         &scope=bowling_reservations               ← required for scope claim
 *                         &center_id=<centerId>                     ← required for center_id claim
 *
 *   API calls   — Authorization: Bearer <token>
 *                   api-version: 2025-12-01.1.0
 *
 *   Token is per-center (center_id in the JWT). Cached in Redis at
 *   qamf:bowling:access-token:<centerId>.
 *
 * Env vars (set on Vercel):
 *   QAMF_BOWLING_CLIENT_ID      — required (same credentials for all centers)
 *   QAMF_BOWLING_CLIENT_SECRET  — required (same credentials for all centers)
 *   QAMF_BOWLING_WEBHOOK_SECRET — optional (for webhook HMAC validation)
 *
 * The same client_id/secret are used for every center. QAMF scopes the returned
 * token to the specific center via the center_id field in the token request body.
 * Tokens are cached separately per center (qamf:bowling:access-token:<centerId>).
 */

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const CACHE_KEY = "qamf:bowling:access-token";
// Cache for 23h — tokens come back as expires_in: 86400 (~24h).
const CACHE_TTL_SECONDS = 60 * 60 * 23;
// Default center ID when none is specified.
const DEFAULT_CENTER_ID = 9172;

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}

async function mintToken(centerId: number = DEFAULT_CENTER_ID): Promise<string> {
  const clientId = process.env.QAMF_BOWLING_CLIENT_ID;
  const clientSecret = process.env.QAMF_BOWLING_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QAMF_BOWLING_CLIENT_ID / QAMF_BOWLING_CLIENT_SECRET not set");
  }

  // Must use form-encoded body (not JSON) and include scope + center_id.
  // Without scope=bowling_reservations the token has no scope claim and
  // every API call returns 401. center_id scopes the token to a specific center.
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "bowling_reservations",
    center_id: String(centerId),
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
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
  await redis.set(`${CACHE_KEY}:${centerId}`, json.access_token, "EX", CACHE_TTL_SECONDS);
  return json.access_token;
}

/** Get a valid Bearer token for a center. Cached in Redis; re-mints on cache miss. */
export async function getQamfBowlingToken(centerId: number = DEFAULT_CENTER_ID): Promise<string> {
  const key = `${CACHE_KEY}:${centerId}`;
  const cached = await redis.get(key);
  if (cached) return cached;
  return mintToken(centerId);
}

/** Force-evict the cached token (call after a 401 before retrying). */
export async function invalidateQamfBowlingToken(
  centerId: number = DEFAULT_CENTER_ID,
): Promise<void> {
  await redis.del(`${CACHE_KEY}:${centerId}`);
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
  centerId: number = DEFAULT_CENTER_ID,
): Promise<Response> {
  const subKey = getQamfSubscriptionKey();
  let token = await getQamfBowlingToken(centerId);
  let res = await doFetch(token, subKey);
  if (res.status === 401 || res.status === 403) {
    await invalidateQamfBowlingToken(centerId);
    token = await mintToken(centerId);
    res = await doFetch(token, subKey);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`qamf-bowling ${errLabel} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res;
}
