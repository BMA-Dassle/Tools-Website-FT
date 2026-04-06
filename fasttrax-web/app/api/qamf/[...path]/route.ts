import { NextRequest, NextResponse } from "next/server";

const QAMF_BASE = "https://qcloud.qubicaamf.com/bowler";

/**
 * Catch-all proxy for QubicaAMF Bowler API.
 * Forwards /api/qamf/centers/9172/... → qcloud.qubicaamf.com/bowler/centers/9172/...
 *
 * Temporary integration — will be replaced with BMI/SMS-Timing in the future.
 * Only this file needs to change when that happens.
 */

function buildUrl(path: string[], searchParams: URLSearchParams): string {
  const qamfPath = path.join("/");
  const qs = searchParams.toString();
  return `${QAMF_BASE}/${qamfPath}${qs ? `?${qs}` : ""}`;
}

const QAMF_SUBSCRIPTION_KEY = process.env.QAMF_SUBSCRIPTION_KEY || "93108f56-0825-4030-b85f-bc6a69fa502c";

function proxyHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "ocp-apim-subscription-key": QAMF_SUBSCRIPTION_KEY,
  };
}

async function proxyRequest(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
  method: string
) {
  try {
    const { path } = await params;
    const url = buildUrl(path, req.nextUrl.searchParams);

    const fetchOptions: RequestInit = {
      method,
      headers: proxyHeaders(),
    };

    // Forward x-sessiontoken if present
    const sessionToken = req.headers.get("x-sessiontoken");
    if (sessionToken) {
      (fetchOptions.headers as Record<string, string>)["x-sessiontoken"] = sessionToken;
    }

    // Log for debugging confirm calls
    if (path.join("/").includes("confirm")) {
      console.log("[qamf proxy] confirm call, sessionToken:", sessionToken ? "present (" + sessionToken.substring(0, 20) + "...)" : "MISSING");
    }

    if (method !== "GET" && method !== "HEAD") {
      try {
        const body = await req.text();
        if (body) fetchOptions.body = body;
      } catch {
        // No body — that's fine for PATCH/PUT with empty bodies
      }
    }

    const res = await fetch(url, fetchOptions);

    // Handle no-content responses
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return new NextResponse(null, { status: res.status });
    }

    // Capture session token from response to forward to client
    const respSessionToken = res.headers.get("x-sessiontoken");
    const extraHeaders: Record<string, string> = {};
    if (respSessionToken) extraHeaders["x-sessiontoken"] = respSessionToken;

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      return NextResponse.json(data, { status: res.status, headers: extraHeaders });
    }

    // Non-JSON response (e.g. plain text boolean)
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      return NextResponse.json(parsed, { status: res.status, headers: extraHeaders });
    } catch {
      return new NextResponse(text, {
        status: res.status,
        headers: { "Content-Type": "text/plain", ...extraHeaders },
      });
    }
  } catch (err) {
    console.error("[qamf proxy] Error:", err);
    return NextResponse.json({ error: "QAMF proxy error" }, { status: 502 });
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
