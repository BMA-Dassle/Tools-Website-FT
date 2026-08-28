import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import type { NextAuthRequest } from "next-auth";
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
 * signing them in again cannot fix it — so a NAVIGATION goes to
 * /sso/error?code=SSO_E_NO_ROLE, which tells them to ask for access. The same
 * api/asset split applies there as here: an /api/* call gets 403
 * {error:"sso_no_role"} (403, not 401 — do not invite a re-auth that cannot
 * help) and anything else gets 404, because an HTML explanation is only useful
 * to something that renders HTML.
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
/**
 * Headers that state WHO the request is from. The shell is the only thing
 * entitled to write them; they are stripped off every inbound request before
 * the shell sets its own. Add to this list, never replace it.
 */
const IDENTITY_HEADERS = ["x-sso-email", "x-sso-name"] as const;

/**
 * The routing decision for one request, with the session already attached by
 * `auth()`. Exported so the tests can drive it directly; wired up as the
 * proxy's default export below.
 */
export function handleAdminRouting(request: NextAuthRequest): NextResponse {
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
    //
    // Same three-way split as the no-session branch above, and for the same
    // reason: only a navigation can be shown an HTML explanation. A board's
    // XHR that follows a 302 to /sso/error parses a page as JSON and reports a
    // syntax error; an asset request that follows it caches HTML as CSS.
    //
    // 403, not the 401 the no-session branch uses: 401 means "authenticate and
    // try again", which is precisely the loop this branch exists to prevent.
    // The caller is authenticated; it is the role that is missing.
    if (isApiPath(request.nextUrl.pathname)) {
      return NextResponse.json({ error: "sso_no_role" }, { status: 403 });
    }
    if (!isPageLikeGet(request)) return notFound();
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
    // Never forward a caller-supplied proxy key. With ADMIN_PROXY_KEY set the
    // line below overwrites it anyway; with it unset, a copied-through header
    // would be the visitor speaking to the upstream gate in the shell's voice.
    requestHeaders.delete("x-admin-proxy-key");
    if (proxyKey) requestHeaders.set("x-admin-proxy-key", proxyKey);
    // Who is looking at this board. The upstream does not authenticate on
    // these — they are for audit lines and "signed in as" chrome, and the
    // proxy key is what makes them trustworthy there.
    //
    // DELETE BEFORE SET, ALWAYS. `requestHeaders` starts as a copy of the
    // VISITOR's headers, so any x-sso-* they send arrives here. Setting only
    // when the session has the field would forward the visitor's own value
    // whenever it does not — a signed-in temp typing one header could sign the
    // audit trail as anyone. The proxy key vouches for these headers upstream,
    // so they must be OURS or absent, never the caller's. Any future identity
    // header goes in this list on the same day it is added.
    for (const h of IDENTITY_HEADERS) requestHeaders.delete(h);
    if (session.user?.email) requestHeaders.set("x-sso-email", session.user.email);
    if (session.user?.name) requestHeaders.set("x-sso-name", session.user.name);
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  return notFound();
}

/** What Next calls: `(request, event) => Response`. */
type ProxyHandler = (req: NextRequest, ev: NextFetchEvent) => Promise<Response>;

/**
 * `export default auth(handleAdminRouting)` is what the Auth.js docs show, and
 * it does not work here. Next's proxy loader takes `mod.proxy ?? mod.default`
 * and hard-fails on `typeof handlerUserland !== "function"`
 * (next/dist/build/templates/middleware.js), so the shell answered
 *
 *   The Proxy file "/proxy" must export a function named `proxy` or a default
 *   function.
 *
 * to EVERY request — including /sso/error and /api/auth/*, i.e. the entire
 * front door. The cause is the deliberate factory in auth.ts: for a FUNCTION
 * config, next-auth's `initAuth` returns an `async` wrapper, so
 * `auth(handleAdminRouting)` is a `Promise` of the handler rather than the
 * handler. (auth.ts must keep the factory — it is what makes the config read
 * the RUNTIME environment; see the comment there.)
 *
 * Awaiting it inside a real function is the whole fix, and the `await`
 * degrades to a no-op if next-auth ever returns the handler synchronously
 * again. proxy.test.ts cannot catch this — it mocks `auth` to the identity
 * function so it can drive the routing with hand-built sessions — so the
 * export shape is pinned in proxy.contract.test.ts against the real module.
 */
export default async function proxy(req: NextRequest, ev: NextFetchEvent): Promise<Response> {
  const handler = (await auth(handleAdminRouting)) as unknown as ProxyHandler;
  return handler(req, ev);
}

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
