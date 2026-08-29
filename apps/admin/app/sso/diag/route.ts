import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import pino from "pino";
import { auth, hasAccess, REQUIRED_ROLE } from "@/auth";
import { recentSsoErrors } from "@/src/sso-log";

/**
 * GET /sso/diag — "is the SSO side of this app healthy, and why did that
 * sign-in fail?", answerable from a terminal with one curl and no dashboard.
 *
 * Every consumer of the gateway exposes this same shape, so one script can
 * sweep all of them (`scripts/diag.mjs` in the gateway repo). It reports
 * whether discovery and JWKS are reachable AND how long each took — a gateway
 * that answers in 4 seconds is the cause of a "sign-in hangs" report, and a
 * boolean would have hidden it.
 *
 * NEVER A SECRET. Env is reported as presence only. The caller's own session is
 * summarised (valid / exp / roles) — never the token.
 *
 * Auth: Bearer DIAG_SECRET. 401 otherwise, including when DIAG_SECRET is unset:
 * an unset secret must not open the endpoint (fail closed, always).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = pino({ name: "ft-admin-proxy" });

/** Timed reachability probe. Never throws — a dead gateway is a RESULT here. */
async function probe(url: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  if (!url) return { ok: false, ms: 0, error: "SSO_ISSUER not configured" };
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    return {
      ok: res.ok,
      ms: Date.now() - started,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: (e as Error).message };
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.DIAG_SECRET || "";
  const provided = req.headers.get("authorization") || "";
  if (!secret || provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const issuer = process.env.SSO_ISSUER || "";
  const [discovery, jwks] = await Promise.all([
    probe(issuer ? `${issuer}/.well-known/openid-configuration` : ""),
    probe(issuer ? `${issuer}/jwks` : ""),
  ]);

  const session = await auth().catch(() => null);

  const body = {
    app: "ft-admin-proxy",
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
    issuer,
    clientId: process.env.SSO_CLIENT_ID || "fasttrax-admin",
    callbackUrl: `${process.env.AUTH_URL || req.nextUrl.origin}/api/auth/callback/headpinz`,
    discovery,
    jwks,
    session: {
      present: !!session,
      // "valid" means usable by THIS app: signed in AND holding the role.
      valid: hasAccess(session),
      exp: session?.expires ?? null,
      roles: session?.roles ?? [],
      requiredRole: REQUIRED_ROLE,
    },
    // Presence only — never values.
    env: {
      SSO_ISSUER: !!process.env.SSO_ISSUER,
      SSO_CLIENT_ID: !!process.env.SSO_CLIENT_ID,
      SSO_CLIENT_SECRET: !!process.env.SSO_CLIENT_SECRET,
      AUTH_SECRET: !!process.env.AUTH_SECRET,
      DIAG_SECRET: true,
      ADMIN_PROXY_KEY: !!process.env.ADMIN_PROXY_KEY,
      ADMIN_CAMERA_TOKEN: !!process.env.ADMIN_CAMERA_TOKEN,
      ADMIN_UPSTREAM_ORIGIN: !!process.env.ADMIN_UPSTREAM_ORIGIN,
    },
    recentErrors: recentSsoErrors(),
  };

  log.info({ event: "diag.accessed", discoveryOk: discovery.ok, jwksOk: jwks.ok }, "sso diag");
  return NextResponse.json(body);
}
