import { NextResponse } from "next/server";
import { auth, hasAccess } from "./auth";
import { resolveAdminProxyPath } from "./src/routes";

/**
 * The staff admin front door. Every human path into the FastTrax admin tools
 * runs through this file: it authenticates the person with Microsoft (via the
 * HeadPinz SSO gateway) and then serves the tools at clean URLs (/pit, /videos,
 * /daily-events-v2, …) by proxying to the MAIN deployment, which holds all
 * secrets and executes all server code. src/routes.ts is the routing table and
 * the reasoning; this file is auth + env + forwarding.
 *
 * SSO REPLACED VERCEL AUTHENTICATION (2026-08-28). The wall used to gate on
 * "has a Vercel account on this team" — right people, wrong question, and no
 * record of who opened which board. Now it gates on a HeadPinz Entra account
 * holding the `fasttrax-admin.access` app role, and every sign-in lands in the
 * gateway's audit log.
 *
 * FOUR OUTCOMES FOR A REQUEST WITH NO SESSION, because "redirect to sign-in" is
 * the right answer for exactly one of them:
 *   - a `self` path (/api/auth/*, /sso/*) → let it through. Gating the sign-in
 *     route on being signed in is an infinite redirect.
 *   - a page-like GET → Auth.js sign-in, with callbackUrl set to the URL they
 *     actually asked for, so a bookmarked board reopens itself afterwards.
 *   - an /api/* call → 401 {error:"sso_expired"}. A board's XHR must not get a
 *     302-to-Microsoft: the fetch follows it, parses HTML as JSON, and the
 *     board shows a parse error instead of "your session ended".
 *   - an asset → 404. A CSS file cannot sign anyone in, and redirecting it just
 *     pollutes the sign-in page's callback with a stylesheet URL.
 *
 * A session WITHOUT the role is a different failure from no session at all —
 * signing them in again cannot fix it — so it goes to /sso/error?code=SSO_E_NO_ROLE,
 * which tells them to ask for access.
 *
 * EDGE-COMPATIBLE. Auth.js's `jwt` session strategy reads the session out of
 * the cookie with no database call, which is what lets this whole file run in
 * the edge runtime on every request.
 *
 * Env (this project only):
 *   SSO_ISSUER, SSO_CLIENT_ID, SSO_CLIENT_SECRET, AUTH_SECRET
 *                          the gateway client — see auth.ts
 *   DIAG_SECRET            bearer for GET /sso/diag
 *   ADMIN_CAMERA_TOKEN     the main site's current admin token, injected into
 *                          forwarded page paths (fails closed if unset)
 *   ADMIN_PROXY_KEY        shared secret forwarded as x-admin-proxy-key; the
 *                          main gate accepts it as a credential, which is what
 *                          lets the URL token later rotate to a machine-only
 *                          value (optional until then)
 *   ADMIN_UPSTREAM_ORIGIN  override for local dev (defaults to the public
 *                          main site)
 *
 * No matcher config on purpose: the shell owns no assets or routes, so the
 * proxy must see every request — including /_next/* — to forward it.
 */
export default auth((request) => {
  const upstream = process.env.ADMIN_UPSTREAM_ORIGIN || "https://headpinz.com";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  const proxyKey = process.env.ADMIN_PROXY_KEY || "";

  const decision = resolveAdminProxyPath(request.nextUrl.pathname, expected);

  // Auth.js's own routes and our SSO pages answer for themselves, signed in or
  // not. Decided before any session check — see the header comment.
  if (decision.kind === "self") return NextResponse.next();

  const session = request.auth;

  if (!session) {
    if (decision.kind === "not-found") {
      // Nothing here to sign in FOR. Stay a 404 rather than advertising that
      // the domain exists by bouncing every scan to Microsoft.
      return notFound();
    }
    if (isApiPath(request.nextUrl.pathname)) {
      return NextResponse.json({ error: "sso_expired" }, { status: 401 });
    }
    if (!isPageLikeGet(request)) return notFound();
    return NextResponse.redirect(signInUrl(request));
  }

  if (!hasAccess(session)) {
    // Signed in, no role. A second sign-in cannot fix it, so never loop them
    // back to Microsoft — say what is wrong and who can fix it.
    const url = request.nextUrl.clone();
    url.pathname = "/sso/error";
    url.search = "";
    url.searchParams.set("code", "SSO_E_NO_ROLE");
    return NextResponse.redirect(url);
  }

  // ── Authenticated staff: exactly the routing this project has always done ──
  if (decision.kind === "redirect") {
    // 307, not 308: browsers heuristically cache 308s, and a cached
    // token-path mapping would outlive an ADMIN_CAMERA_TOKEN rotation.
    const url = request.nextUrl.clone(); // query survives the clone
    url.pathname = decision.pathname;
    return NextResponse.redirect(url, 307);
  }

  if (decision.kind === "forward" || decision.kind === "forward-admin") {
    const url = new URL(decision.pathname + request.nextUrl.search, upstream);
    const requestHeaders = new Headers(request.headers);
    if (proxyKey) requestHeaders.set("x-admin-proxy-key", proxyKey);
    // Who is looking at this board. The upstream does not authenticate on
    // these — they are for audit lines and "signed in as" chrome, and the
    // proxy key is what makes them trustworthy there.
    if (session.user?.email) requestHeaders.set("x-sso-email", session.user.email);
    if (session.user?.name) requestHeaders.set("x-sso-name", session.user.name);
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  return notFound();
});

/** Same opaque fail-closed body as the main deployment's admin gate. */
function notFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}

/** `/api` and below — the paths whose callers parse JSON, not HTML. */
function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * A navigation a human can be bounced from. Anything else (a POST, an XHR, a
 * subresource) must not be turned into a sign-in redirect: `Sec-Fetch-Mode:
 * navigate` is the browser's own statement that this is a page load, and the
 * Accept header is the fallback for clients that omit it.
 */
function isPageLikeGet(request: { method: string; headers: Headers }): boolean {
  if (request.method !== "GET") return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") || "").includes("text/html");
}

/**
 * Auth.js's sign-in URL, carrying the URL the person actually asked for so
 * they land on their board and not on a bare root. `callbackUrl` is a
 * same-origin path only — Auth.js rejects cross-origin callbacks, and so
 * should we.
 */
function signInUrl(request: { nextUrl: URL }): URL {
  const url = new URL("/api/auth/signin", request.nextUrl.origin);
  url.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
  return url;
}
