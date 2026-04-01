import { NextRequest, NextResponse } from "next/server";

// ── Config from env ───────────────────────────────────────────────────────────

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

// ── JWT token cache ───────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0; // unix ms

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }

  const res = await fetch(`${BMI_API_URL}/auth/${BMI_CLIENT_KEY}/publicbooking`, {
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
  cachedToken = data.AccessToken || data.accessToken;
  const expiresIn = parseInt(data.ExpiresIn || data.expiresIn || "3600", 10);
  tokenExpiry = Date.now() + expiresIn * 1000;

  return cachedToken!;
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
];

const ALLOWED_POST = [
  "availability",
  "booking/book",
  "booking/sell",
  "booking/memo",
  "booking/removeItem",
  "payment/confirm",
  "person/registerContactPerson",
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
    const token = await getToken();

    // Build upstream URL — pass through all query params except 'endpoint'
    const upstreamParams = new URLSearchParams();
    for (const [k, v] of searchParams) {
      if (k !== "endpoint") upstreamParams.set(k, v);
    }
    const qs = upstreamParams.toString();
    const url = `${BMI_API_URL}/public-booking/${BMI_CLIENT_KEY}/${endpoint}${qs ? `?${qs}` : ""}`;

    const upstream = await fetch(url, {
      headers: bmiHeaders(token),
      cache: "no-store",
    });

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
    const token = await getToken();
    const body = await req.json().catch(() => ({}));

    // Build upstream URL with query params
    const upstreamParams = new URLSearchParams();
    for (const [k, v] of searchParams) {
      if (k !== "endpoint") upstreamParams.set(k, v);
    }
    const qs = upstreamParams.toString();
    const url = `${BMI_API_URL}/public-booking/${BMI_CLIENT_KEY}/${endpoint}${qs ? `?${qs}` : ""}`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: bmiHeaders(token),
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
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
    const token = await getToken();
    const url = `${BMI_API_URL}/public-booking/${BMI_CLIENT_KEY}/${endpoint}`;

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
