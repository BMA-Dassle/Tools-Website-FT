import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const OFFICE_API = "https://office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
// Base64-encoded to avoid dotenv $variable expansion: JGMxbjFlbGxv = $c1n1ello
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

function officeHeaders(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    "Accept": "application/json, text/plain, */*",
    "clientkey": CLIENT_KEY,
  };
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
  const res = await fetch(`${OFFICE_API}/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "clientkey": CLIENT_KEY,
      "x-fast-version": SMS_VERSION,
    },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[BMI Office auth] ${res.status}: ${errBody}`);
    throw new Error(`Office auth failed: ${res.status} — ${errBody}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  const expiresIn = parseInt(data.expires_in || "86400", 10);
  tokenExpiry = Date.now() + expiresIn * 1000;

  return cachedToken!;
}

// ── GET handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    let token = await getOfficeToken();

    // Person search by email/name
    if (action === "search") {
      const query = searchParams.get("q") || "";
      const max = searchParams.get("max") || "20";
      if (!query) {
        return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
      }

      const url = `${OFFICE_API}/api/${CLIENT_KEY}/search/person?token=${encodeURIComponent(query)}&maxResults=${max}`;
      console.log(`[BMI Office search] ${url} token_start=${token.substring(0, 20)}`);
      const res = await fetch(url, {
        headers: officeHeaders(token),
        cache: "no-store",
      });
      let rawText = await res.text();
      console.log(`[BMI Office search] ${res.status}: ${rawText.substring(0, 300)}`);

      // If 500/401, token might be bad — clear cache and retry once
      if (res.status >= 400) {
        console.log("[BMI Office] Clearing token cache and retrying...");
        cachedToken = null;
        tokenExpiry = 0;
        token = await getOfficeToken();
        const retry = await fetch(url, {
          headers: officeHeaders(token),
          cache: "no-store",
        });
        rawText = await retry.text();
        console.log(`[BMI Office search retry] ${retry.status}: ${rawText.substring(0, 300)}`);
      }

      try {
        return NextResponse.json(JSON.parse(rawText), { status: 200 });
      } catch {
        return NextResponse.json({ error: rawText.substring(0, 200) }, { status: 500 });
      }
    }

    // Person details by ID
    if (action === "person") {
      const id = searchParams.get("id") || "";
      if (!id) {
        return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
      }

      const url = `${OFFICE_API}/api/${CLIENT_KEY}/person/${id}`;
      const res = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "x-fast-version": SMS_VERSION,
        },
        cache: "no-store",
      });
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json({ error: "Unknown action. Use ?action=search&q=email or ?action=person&id=123" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Office API error" },
      { status: 500 },
    );
  }
}
