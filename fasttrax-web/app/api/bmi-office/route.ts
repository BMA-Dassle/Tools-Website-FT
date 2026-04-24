import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { randomUUID } from "crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
// Base64-encoded to avoid dotenv $variable expansion: JGMxbjFlbGxv = $c1n1ello
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

// ── HTTPS helpers (Node fetch/undici doesn't work with this API) ────────────

function httpsGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function httpsPost(path: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: OFFICE_HOST, path, method: "POST", headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body);
    req.end();
  });
}

// ── Token cache ─────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getOfficeToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }

  const body = `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`;
  console.log(`[BMI Office auth] user=${OFFICE_USER}`);
  const res = await httpsPost("/auth/token", body, {
    "Content-Type": "application/x-www-form-urlencoded",
    "clientkey": CLIENT_KEY,
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
    "Authorization": `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    "clientkey": CLIENT_KEY,
  };
}

// ── GET handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    const token = await getOfficeToken();

    // Person search by email/name
    if (action === "search") {
      const query = searchParams.get("q") || "";
      const max = searchParams.get("max") || "20";
      if (!query) {
        return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
      }

      const path = `/api/${CLIENT_KEY}/search/person?token=${encodeURIComponent(query)}&maxResults=${max}`;
      const res = await httpsGet(path, apiHeaders(token));
      console.log(`[BMI Office search] ${res.status} (${query})`);

      if (res.status >= 400) {
        // Token might be stale — clear and retry
        cachedToken = null;
        tokenExpiry = 0;
        const newToken = await getOfficeToken();
        const retry = await httpsGet(path, apiHeaders(newToken));
        return NextResponse.json(JSON.parse(retry.body), { status: retry.status >= 400 ? 500 : 200 });
      }

      return NextResponse.json(JSON.parse(res.body));
    }

    // Person details by ID
    if (action === "person") {
      const id = searchParams.get("id") || "";
      if (!id) {
        return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
      }

      const path = `/api/${CLIENT_KEY}/person/${id}`;
      const res = await httpsGet(path, apiHeaders(token));
      return NextResponse.json(JSON.parse(res.body), { status: res.status >= 400 ? 500 : 200 });
    }

    // Project details by ID (returns projectReference for waiver link)
    if (action === "project") {
      const id = searchParams.get("id") || "";
      if (!id) {
        return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
      }

      const path = `/api/${CLIENT_KEY}/project/${id}`;
      const res = await httpsGet(path, apiHeaders(token));
      if (res.status >= 400) {
        // Token might be stale
        cachedToken = null;
        tokenExpiry = 0;
        const newToken = await getOfficeToken();
        const retry = await httpsGet(path, apiHeaders(newToken));
        return NextResponse.json(JSON.parse(retry.body), { status: retry.status >= 400 ? 500 : 200 });
      }
      return NextResponse.json(JSON.parse(res.body));
    }

    // Deposit history — check credit balance for a person
    if (action === "deposits") {
      const personId = searchParams.get("personId") || "";
      if (!personId) {
        return NextResponse.json({ error: "Missing personId parameter" }, { status: 400 });
      }
      // Default: look back 2 years
      const now = new Date();
      const from = searchParams.get("from") || new Date(now.getFullYear() - 2, now.getMonth(), now.getDate()).toISOString().split(".")[0];
      const until = searchParams.get("until") || now.toISOString().split(".")[0];

      const path = `/api/${CLIENT_KEY}/deposit/history?personId=${personId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`;
      const res = await httpsGet(path, apiHeaders(token));
      if (res.status >= 400) {
        cachedToken = null;
        tokenExpiry = 0;
        const newToken = await getOfficeToken();
        const retry = await httpsGet(path, apiHeaders(newToken));
        return NextResponse.json(JSON.parse(retry.body), { status: retry.status >= 400 ? 500 : 200 });
      }
      return NextResponse.json(JSON.parse(res.body));
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Office API error" },
      { status: 500 },
    );
  }
}
