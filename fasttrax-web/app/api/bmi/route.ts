import { NextRequest, NextResponse } from "next/server";

// ── Config from env ───────────────────────────────────────────────────────────

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

// ── JWT token cache (per client key) ─────────────────────────────────────────

const ALLOWED_CLIENTS = new Set(["headpinzftmyers", "headpinznaples"]);
const tokenCache: Record<string, { token: string; expiry: number }> = {};

async function getToken(clientKey = BMI_CLIENT_KEY): Promise<string> {
  const cached = tokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) {
    return cached.token;
  }

  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BMI-Subscription-Key": BMI_SUB_KEY,
    },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`BMI auth failed: ${res.status}`);
  }

  const data = await res.json();
  const token = data.AccessToken || data.accessToken;
  const expiresIn = parseInt(data.ExpiresIn || data.expiresIn || "3600", 10);
  tokenCache[clientKey] = { token, expiry: Date.now() + expiresIn * 1000 };

  return token;
}

function bmiHeaders(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "BMI-Subscription-Key": BMI_SUB_KEY,
    "Content-Type": "application/json",
    "Accept-Language": "en",
  };
}

// ── Allowed endpoints ─────────────────────────────────────────────────────────

const ALLOWED_GET = [
  "page",
  "products",
  "availability",
  "image/product",
  "order",
  "person",
  "subscription",
];

const ALLOWED_POST = [
  "availability",
  "booking/book",
  "booking/sell",
  "booking/memo",
  "booking/removeItem",
  "payment/confirm",
  "person/registerContactPerson",
  "person/registerProjectPerson",
];

const ALLOWED_DELETE = [
  "bill", // bill/{orderId}/cancel
];

// ── GET handler ───────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");

  if (!endpoint || !ALLOWED_GET.some(e => endpoint.startsWith(e))) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
  }

  try {
    const clientKey = searchParams.get("clientKey") || BMI_CLIENT_KEY;
    if (!ALLOWED_CLIENTS.has(clientKey)) return NextResponse.json({ error: "Invalid client" }, { status: 403 });
    const token = await getToken(clientKey);

    // Build upstream URL — pass through all query params except 'endpoint' and 'clientKey'
    const upstreamParams = new URLSearchParams();
    for (const [k, v] of searchParams) {
      if (k !== "endpoint" && k !== "clientKey") upstreamParams.set(k, v);
    }
    const qs = upstreamParams.toString();
    const url = `${BMI_API_URL}/public-booking/${clientKey}/${endpoint}${qs ? `?${qs}` : ""}`;

    console.log(`[BMI GET] ${url}`);
    const upstream = await fetch(url, {
      headers: bmiHeaders(token),
      cache: "no-store",
    });
    if (!upstream.ok && endpoint.includes("order")) {
      const errBody = await upstream.text();
      console.error(`[BMI GET ERROR] ${upstream.status}: ${errBody}`);
      return NextResponse.json(JSON.parse(errBody), { status: upstream.status });
    }

    // Image endpoint returns binary
    if (endpoint === "image/product") {
      const contentType = upstream.headers.get("content-type") || "image/png";
      const buffer = await upstream.arrayBuffer();
      return new NextResponse(buffer, {
        headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" },
      });
    }

    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "BMI API error" },
      { status: 500 },
    );
  }
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");

  if (!endpoint || !ALLOWED_POST.some(e => endpoint.startsWith(e))) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
  }

  try {
    const clientKey = searchParams.get("clientKey") || BMI_CLIENT_KEY;
    if (!ALLOWED_CLIENTS.has(clientKey)) return NextResponse.json({ error: "Invalid client" }, { status: 403 });
    const token = await getToken(clientKey);

    // Build upstream URL with query params
    const upstreamParams = new URLSearchParams();
    for (const [k, v] of searchParams) {
      if (k !== "endpoint" && k !== "clientKey") upstreamParams.set(k, v);
    }
    const qs = upstreamParams.toString();
    const url = `${BMI_API_URL}/public-booking/${clientKey}/${endpoint}${qs ? `?${qs}` : ""}`;

    // Pass request body as raw text to avoid JSON number precision loss on orderId
    const bodyStr = await req.text();
    console.log(`[BMI POST] ${url}`);
    if (endpoint.startsWith("booking/book")) {
      console.log(`[BMI POST body] ${bodyStr.substring(0, 500)}`);
    }

    const upstream = await fetch(url, {
      method: "POST",
      headers: bmiHeaders(token),
      body: bodyStr,
      cache: "no-store",
    });

    // Return raw text for booking endpoints to avoid JSON number precision loss
    // (orderId values exceed Number.MAX_SAFE_INTEGER)
    const rawText = await upstream.text();
    if (endpoint.startsWith("booking/")) {
      console.log(`[BMI POST response] ${rawText.substring(0, 500)}`);
    }
    return new NextResponse(rawText, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "BMI API error" },
      { status: 500 },
    );
  }
}

// ── DELETE handler ────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint");

  if (!endpoint || !ALLOWED_DELETE.some(e => endpoint.startsWith(e))) {
    return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
  }

  try {
    const clientKey = searchParams.get("clientKey") || BMI_CLIENT_KEY;
    if (!ALLOWED_CLIENTS.has(clientKey)) return NextResponse.json({ error: "Invalid client" }, { status: 403 });
    const token = await getToken(clientKey);
    const url = `${BMI_API_URL}/public-booking/${clientKey}/${endpoint}`;

    const upstream = await fetch(url, {
      method: "DELETE",
      headers: bmiHeaders(token),
      cache: "no-store",
    });

    // Cancel returns raw `true`/`false`
    const text = await upstream.text();
    try {
      return NextResponse.json(JSON.parse(text), { status: upstream.status });
    } catch {
      return NextResponse.json({ success: text === "true" }, { status: upstream.status });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "BMI API error" },
      { status: 500 },
    );
  }
}
