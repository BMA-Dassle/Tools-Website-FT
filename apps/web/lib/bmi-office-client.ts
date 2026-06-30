/**
 * BMI / SMS-Timing Office API client (shared).
 *
 * Extracted from app/api/bmi-office/route.ts so the customer-account dashboard
 * can call the Office API with PRECISION-SAFE id handling. The route historically
 * did `JSON.parse(res.body)`, which rounds 17-digit personIds (the BMI precision
 * bug). Callers that need an id (person search → personId) must instead take the
 * RAW `body` returned here and run it through `parseWithRawIds` from `@ft/db`.
 *
 * Node's fetch/undici does not work with this host, so we use the `https` module
 * directly (same as the original route). The OAuth token is cached module-wide
 * and refreshed ~60s before expiry; `officeGet` transparently re-auths and
 * retries once on a >=400 (a stale token is the common cause).
 */
import https from "https";
import { randomUUID } from "crypto";

const OFFICE_HOST = "office-api22.sms-timing.com";
export const BMI_CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
// Base64-encoded to avoid dotenv $variable expansion: JGMxbjFlbGxv = $c1n1ello
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

export interface OfficeResponse {
  status: number;
  body: string;
}

function httpsGet(path: string, headers: Record<string, string>): Promise<OfficeResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

function httpsPost(
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<OfficeResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(body);
    req.end();
  });
}

let cachedToken: string | null = null;
let tokenExpiry = 0;

export async function getOfficeToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }
  const body = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  const res = await httpsPost("/auth/token", body, {
    "Content-Type": "application/x-www-form-urlencoded",
    clientkey: BMI_CLIENT_KEY,
    "x-fast-version": SMS_VERSION,
  });
  if (res.status !== 200) {
    console.error(`[BMI Office auth] ${res.status}: ${res.body}`);
    throw new Error(`Office auth failed: ${res.status}`);
  }
  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  const expiresIn = parseInt(data.expires_in || "86400", 10);
  tokenExpiry = Date.now() + expiresIn * 1000;
  return cachedToken!;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: BMI_CLIENT_KEY,
  };
}

/**
 * GET an Office API path, returning the RAW response body (never JSON-parsed
 * here — the caller decides whether to use parseWithRawIds). Auto re-auths and
 * retries once on a >=400, which is almost always a stale cached token.
 */
export async function officeGet(path: string): Promise<OfficeResponse> {
  const token = await getOfficeToken();
  const res = await httpsGet(path, apiHeaders(token));
  if (res.status < 400) return res;
  const fresh = await getOfficeToken(true);
  return httpsGet(path, apiHeaders(fresh));
}
