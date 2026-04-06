import { NextRequest, NextResponse } from "next/server";

const QAMF_BASE = "https://qcloud.qubicaamf.com/bowler";
const QAMF_SUBSCRIPTION_KEY = process.env.QAMF_SUBSCRIPTION_KEY || "93108f56-0825-4030-b85f-bc6a69fa502c";

/**
 * Catch-all proxy for QubicaAMF Bowler API.
 * Forwards /api/qamf/centers/9172/... → qcloud.qubicaamf.com/bowler/centers/9172/...
 *
 * Temporary integration — will be replaced with BMI/SMS-Timing in the future.
 */

function buildUrl(path: string[], searchParams: URLSearchParams): string {
  const qamfPath = path.join("/");
  const qs = searchParams.toString();
  return `${QAMF_BASE}/${qamfPath}${qs ? `?${qs}` : ""}`;
}

async function proxyRequest(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
  method: string
) {
  try {
    const { path } = await params;
    const url = buildUrl(path, req.nextUrl.searchParams);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "ocp-apim-subscription-key": QAMF_SUBSCRIPTION_KEY,
    };

    // Forward x-sessiontoken if present
    const sessionToken = req.headers.get("x-sessiontoken");
    if (sessionToken) {
      headers["x-sessiontoken"] = sessionToken;
    }

    const fetchOptions: RequestInit = { method, headers };

    // Read body for non-GET methods
    if (method !== "GET" && method !== "HEAD") {
      try {
        const body = await req.text();
        if (body) fetchOptions.body = body;
      } catch {
        // No body
      }
    }

    const res = await fetch(url, fetchOptions);

    // Read response body
    let responseText = "";
    try {
      responseText = await res.text();
    } catch {
      // Empty response
    }

    // Build response headers, forwarding session token
    const respHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const respSessionToken = res.headers.get("x-sessiontoken");
    if (respSessionToken) respHeaders["x-sessiontoken"] = respSessionToken;

    // Handle empty responses
    if (!responseText || res.status === 204) {
      return new NextResponse(null, { status: res.status, headers: respHeaders });
    }

    // Return response as-is (preserving QAMF status code for proper error handling)
    return new NextResponse(responseText, {
      status: res.status,
      headers: respHeaders,
    });
  } catch (err) {
    console.error("[qamf proxy] Error:", err);
    return NextResponse.json(
      { error: "QAMF proxy error", details: err instanceof Error ? err.message : "Unknown" },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(req, ctx, "GET");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(req, ctx, "POST");
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(req, ctx, "PUT");
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(req, ctx, "PATCH");
}
