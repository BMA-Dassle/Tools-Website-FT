import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import pino from "pino";
import { auth, hasAdminAccess, REQUIRED_ROLE } from "@/auth";
import { recentSsoErrors } from "~/features/sso/log";
import { DEFAULT_ADMIN_HOST } from "~/features/sso/tools";

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
 * Auth: Bearer DIAG_SECRET, compared in constant time. 401 otherwise,
 * including when DIAG_SECRET is unset: an unset secret must not open the
 * endpoint (fail closed, always). The comparison is timing-safe because this
 * route is public, unrate-limited, and answers about the auth system — the one
 * place a byte-at-a-time oracle would be worth an attacker's time.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = pino({ name: "fasttrax-web-sso" });

/** Length-independent comparison — never `!==` on a credential. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

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
  if (!secret || !timingSafeEqual(provided, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const issuer = process.env.SSO_ISSUER || "";
  const [discovery, jwks] = await Promise.all([
    probe(issuer ? `${issuer}/.well-known/openid-configuration` : ""),
    probe(issuer ? `${issuer}/jwks` : ""),
  ]);

  // A misconfigured Auth.js throws here rather than returning null — the same
  // fail-closed treatment the v2 pages give it.
  const session = await auth().catch(() => null);

  const body = {
    app: "fasttrax-web",
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
    issuer,
    clientId: process.env.SSO_CLIENT_ID || "fasttrax-admin",
    callbackUrl: `${process.env.AUTH_URL || req.nextUrl.origin}/api/auth/callback/headpinz`,
    adminHosts: [DEFAULT_ADMIN_HOST, ...(process.env.ADMIN_HOSTS || "").split(",")]
      .map((h) => h.trim())
      .filter(Boolean),
    discovery,
    jwks,
    session: {
      present: !!session,
      // "valid" means usable by THIS app: signed in AND holding the role.
      valid: hasAdminAccess(session),
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
      AUTH_TRUST_HOST: !!process.env.AUTH_TRUST_HOST,
      DIAG_SECRET: true,
      ADMIN_HOSTS: !!process.env.ADMIN_HOSTS,
      ADMIN_API_SIGNING_SECRET: !!process.env.ADMIN_API_SIGNING_SECRET,
      ADMIN_PUBLIC_URL: !!process.env.ADMIN_PUBLIC_URL,
      ADMIN_CAMERA_TOKEN: !!process.env.ADMIN_CAMERA_TOKEN,
    },
    recentErrors: recentSsoErrors(),
  };

  log.info({ event: "diag.accessed", discoveryOk: discovery.ok, jwksOk: jwks.ok }, "sso diag");
  return NextResponse.json(body);
}
