/**
 * Google service-account auth — exchange a service-account JSON key for
 * an OAuth2 access token suitable for Google API calls (Search Console,
 * Indexing API, etc.).
 *
 * Uses the JWT bearer flow (RFC 7523):
 *   1. Build a JWT header + claim set, sign it with the service account's
 *      RSA private key (RS256)
 *   2. POST the JWT to https://oauth2.googleapis.com/token
 *   3. Receive access_token (valid ~1 hour)
 *
 * Token is cached in-memory until 5 min before expiry so repeated calls
 * within the same Lambda invocation share.
 *
 * Setup required before this works:
 *   1. Google Cloud Console → Create service account → download JSON key
 *   2. Enable "Google Search Console API" + "Indexing API" on the project
 *   3. Google Search Console → Settings → Users and permissions → add
 *      the service account email as Owner for each property
 *   4. Set env var GOOGLE_SERVICE_ACCOUNT_KEY to the FULL JSON key (the
 *      entire object stringified). The key newlines inside private_key
 *      must be preserved — easiest is to paste the JSON unmodified.
 */

import { createSign } from "crypto";

interface ServiceAccountKey {
  type: "service_account";
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  token_uri: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function parseKey(): ServiceAccountKey {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var not set");
  }
  try {
    const parsed = JSON.parse(raw) as ServiceAccountKey;
    if (parsed.type !== "service_account") {
      throw new Error("Not a service_account key");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Exchange the service account for an access token with the given scope(s).
 * Common scopes:
 *   https://www.googleapis.com/auth/webmasters   — Search Console (Sitemaps)
 *   https://www.googleapis.com/auth/indexing     — Indexing API
 */
export async function getGoogleAccessToken(
  scopes: string[] = ["https://www.googleapis.com/auth/webmasters"],
): Promise<string> {
  const scopeKey = scopes.join(" ");
  // Cache only for identical scope. Simple since we rarely mix scopes.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const key = parseKey();
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT", kid: key.private_key_id };
  const claim = {
    iss: key.client_email,
    scope: scopeKey,
    aud: key.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const signInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signInput);
  signer.end();
  const signature = signer.sign(key.private_key);
  const jwt = `${signInput}.${base64UrlEncode(signature)}`;

  const resp = await fetch(key.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Google token exchange failed: ${resp.status} ${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}
