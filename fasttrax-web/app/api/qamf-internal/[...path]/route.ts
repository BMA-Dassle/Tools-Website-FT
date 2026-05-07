import { NextRequest, NextResponse } from "next/server";
import { qamfAuthedFetch } from "@/lib/qamf-bowling-auth";

/**
 * Catch-all proxy for the QubicaAMF Internal API (Bowling Reservations).
 *   /api/qamf-internal/centers/9172/lanes
 *     →  https://api.qubicaamf.com/bowling-reservations/centers/9172/lanes
 *
 * "Internal" here means QubicaAMF's operator-facing reservation
 * management API — NOT the public-facing widget. Used for direct
 * lane reservations, customer info, status changes, and lane opens
 * via OAuth2 client_credentials.
 *
 * Distinct from `/api/qamf/[...path]` (the legacy public bowler proxy
 * at qcloud.qubicaamf.com/bowler that powers `/hp/book/bowling`).
 * Legacy path stays untouched.
 *
 * Auth: server-side only — wraps every call with the Bearer token
 * from `qamf-bowling-auth`. Token never leaves this Lambda.
 *
 * Required env (production):
 *   QAMF_BOWLING_CLIENT_ID       (handled by qamf-bowling-auth)
 *   QAMF_BOWLING_CLIENT_SECRET   (handled by qamf-bowling-auth)
 *
 * Note: the Internal API uses OAuth2 only (per QubicaAMF Overview +
 * Guidelines V1.4 — there is no Azure APIM subscription key).
 * If 401s persist with a valid token, the cause is QubicaAMF-side
 * provisioning: the "Bowling Reservation APIs" service must be
 * added to the active CMP – Business Preferred subscription, and
 * the BMA client must be granted access to the relevant centerIds.
 *
 * Auth at OUR proxy boundary: rely on existing admin-token / x-api-key
 * gating in middleware.ts for any route under /api/admin/*. This
 * `/api/qamf-internal/*` namespace is open by default — gate by IP /
 * referer if we ever expose direct customer-facing booking.
 */

const QAMF_BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VERSION = "2025-12-01.1.0";

function buildUrl(path: string[], searchParams: URLSearchParams): string {
  const tail = path.join("/");
  const qs = searchParams.toString();
  return `${QAMF_BASE}/${tail}${qs ? `?${qs}` : ""}`;
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }, method: string) {
  let bodyText = "";
  if (method !== "GET" && method !== "HEAD") {
    bodyText = await req.text();
  }

  const { path } = await ctx.params;
  const url = buildUrl(path, req.nextUrl.searchParams);

  try {
    const res = await qamfAuthedFetch(
      (token) =>
        fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "api-version": API_VERSION,
            ...(bodyText ? { "content-type": "application/json" } : {}),
          },
          body: bodyText || undefined,
          cache: "no-store",
        }),
      `${method} ${path.join("/")}`,
    );
    const respText = await res.text();
    return new NextResponse(respText || null, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "qamf-internal proxy error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx, "GET");
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx, "POST");
}
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx, "PUT");
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx, "PATCH");
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(req, ctx, "DELETE");
}
