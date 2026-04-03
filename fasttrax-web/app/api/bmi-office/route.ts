import { NextRequest, NextResponse } from "next/server";

// ── Config ──────────────────────────────────────────────────────────────────

const OFFICE_API = "https://office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS = process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";

// ── Token cache ─────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getOfficeToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }

  const body = `grant_type=password&username=${encodeURIComponent(OFFICE_USER)}&password=${encodeURIComponent(OFFICE_PASS)}`;
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
    throw new Error(`Office auth failed: ${res.status}`);
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
    const token = await getOfficeToken();

    // Person search by email/name
    if (action === "search") {
      const query = searchParams.get("q") || "";
      const max = searchParams.get("max") || "20";
      if (!query) {
        return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
      }

      const url = `${OFFICE_API}/api/${CLIENT_KEY}/search/person?token=${encodeURIComponent(query)}&maxResults=${max}`;
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
