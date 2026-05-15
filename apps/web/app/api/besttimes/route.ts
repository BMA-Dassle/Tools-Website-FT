import { NextRequest, NextResponse } from "next/server";

// ── Token auto-renewal ──────────────────────────────────────────────────────

const ENCRYPTED_KEY = "U2FsdGVkX18rw9HVQvtJrdeGZNAVakzC08J8Ij8PZNI%3D";
const API_HOST = "modules-api22.sms-timing.com";
const CLIENT_KEY = "headpinzftmyers";

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const res = await fetch(
    `https://backend.sms-timing.com/api/connectioninfo/encrypted?message=${ENCRYPTED_KEY}&locationType=3&type=modules`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.AccessToken;
  // Refresh every hour (tokens last longer but this keeps them fresh)
  tokenExpiry = Date.now() + 60 * 60 * 1000;
  console.log(`[besttimes] Token refreshed: ${cachedToken}`);
  return cachedToken!;
}

// ── GET handler — proxy besttimes requests with auto-renewed token ──────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const endpoint = searchParams.get("endpoint") || "records";
  const rscId = searchParams.get("rscId") || "-1";
  const scgId = searchParams.get("scgId") || "";
  const startDate = searchParams.get("startDate") || "";
  const maxResult = searchParams.get("maxResult") || "10";

  try {
    const token = await getToken();

    const params = new URLSearchParams({
      locale: "en-US",
      rscId,
      scgId,
      startDate,
      endDate: "",
      maxResult,
      accessToken: token,
    });

    const url = `https://${API_HOST}/api/besttimes/${endpoint}/${CLIENT_KEY}?${params.toString()}`;
    const res = await fetch(url, { cache: "no-store" });

    if (res.status === 401) {
      // Token expired mid-request — refresh and retry once
      cachedToken = null;
      tokenExpiry = 0;
      const newToken = await getToken();
      params.set("accessToken", newToken);
      const retryUrl = `https://${API_HOST}/api/besttimes/${endpoint}/${CLIENT_KEY}?${params.toString()}`;
      const retry = await fetch(retryUrl, { cache: "no-store" });
      const data = await retry.json();
      return NextResponse.json(data, {
        headers: { "Cache-Control": "public, max-age=60" },
      });
    }

    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Besttimes API error" },
      { status: 500 },
    );
  }
}
