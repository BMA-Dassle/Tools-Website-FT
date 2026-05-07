import redis from "@/lib/redis";

/**
 * QubicaAMF Bowling API OAuth2 client_credentials helper.
 *
 * Mints + caches the Bearer token used to call
 *   https://api.qubicaamf.com/bowling-reservations/*
 *
 * Mirrors lib/vt3.ts's getJwt / invalidateJwt pattern: cache in Redis
 * with a TTL just under the token's `expires_in` (24h reported by
 * QubicaAMF, we cache for 23h to leave headroom on clock skew).
 *
 * Env vars (set on Vercel):
 *   QAMF_BOWLING_CLIENT_ID       — required (client id)
 *   QAMF_BOWLING_CLIENT_SECRET   — required (client secret)
 *   QAMF_BOWLING_ACCESS_KEY      — optional; if QubicaAMF later
 *                                  enforces the OAuth-doc's
 *                                  apiKeyHeader gate, set this and
 *                                  it'll get sent as `Access-Key`.
 *                                  Empirically not enforced today.
 *
 * Note: this helper covers ONLY the OAuth handshake. Calls against
 * the bowling-reservations API itself currently return 401 even with
 * a valid Bearer token — the API is hosted behind Azure APIM and
 * appears to require a separate subscription / access key that
 * QubicaAMF hasn't yet provided. Track that env var as
 * `QAMF_BOWLING_API_KEY` (set in lib/qamf-bowling.ts when we build it)
 * and we'll wire it into the bowling client at that layer.
 */

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const CACHE_KEY = "qamf:bowling:access-token";
// Cache for 23h — tokens come back as expires_in: 86399 (~24h);
// 23h leaves an hour of skew tolerance and avoids racing the upstream
// rotation window.
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

  // Optional access-key gate (not currently enforced — see file header)
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

/**
 * Get a valid Bearer token. Cached in Redis; re-mints on cache miss.
 * Callers should wrap downstream calls with `authedFetch` below to
 * automatically retry on a single 401 (mints a fresh token, retries
 * once, then fails through).
 */
export async function getQamfBowlingToken(): Promise<string> {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return cached;
  return mintToken();
}

/** Force-evict the cached token. Use after a 401 from a downstream
 *  bowling-reservations call before re-fetching. */
export async function invalidateQamfBowlingToken(): Promise<void> {
  await redis.del(CACHE_KEY);
}

/**
 * Wrapper that runs a fetch closure with a fresh Bearer token, retries
 * once on 401 with a re-minted token. Mirrors lib/vt3.ts:authedFetch.
 *
 * Usage:
 *   const res = await qamfAuthedFetch(
 *     (token) => fetch(`${BOWLING_BASE}/centers/${id}/lanes`, {
 *       headers: {
 *         authorization: `Bearer ${token}`,
 *         "api-version": "2025-12-01.1.0",
 *       },
 *     }),
 *     "getLanes",
 *   );
 */
export async function qamfAuthedFetch(
  doFetch: (token: string) => Promise<Response>,
  errLabel: string,
): Promise<Response> {
  let token = await getQamfBowlingToken();
  let res = await doFetch(token);
  if (res.status === 401 || res.status === 403) {
    await invalidateQamfBowlingToken();
    token = await mintToken();
    res = await doFetch(token);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`qamf-bowling ${errLabel} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res;
}
