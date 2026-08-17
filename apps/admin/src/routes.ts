/**
 * Admin-proxy route registry — the ONE place that answers "what does a path
 * do on the staff admin domain?".
 *
 * This app is a pure authenticated front door: it owns NO pages and NO API
 * routes. Vercel Authentication guards the domain; proxy.ts executes the
 * decision made here — forwarding staff-tool URLs to the main deployment
 * (fasttraxent.com / headpinz.com — where ALL secrets and server code live)
 * with ADMIN_CAMERA_TOKEN injected into the path, and 404ing everything that
 * is not a staff surface. Because the main deployment executes every
 * request, pay links, self-fetches and .bat scripts see the PUBLIC origin —
 * no env duplication, no origin shims, no cron registration here at all.
 *
 * Rules for changing this file:
 *   - Keep it dependency-free and pure — imported by the edge proxy, so no
 *     `process.env`, no Node APIs. Env reads live in proxy.ts; this module
 *     only maps (pathname, token) → decision.
 *   - ADMIN_TOOL_SLUGS is pinned to the real apps/web/app/admin/[token]/*
 *     directories by routes.test.ts — adding tool #22 in apps/web without
 *     updating this list fails CI (and needs a redeploy of THIS app, the
 *     only time it ever redeploys).
 */

/** The staff tools under apps/web/app/admin/[token]/ — first path segment of
 *  every clean admin URL. Deeper segments ride along (/camera-assign/blue,
 *  /daily-events/{projectId}). */
export const ADMIN_TOOL_SLUGS: ReadonlySet<string> = new Set([
  "api-docs",
  "briefing",
  "camera-assign",
  "checkin",
  "christmas-in-july",
  "daily-events",
  "daily-events-v2",
  "deals",
  "deposit-failures",
  "discount-codes",
  "e-tickets",
  "group-approvals",
  "group-functions",
  "healthnet",
  "kbf",
  "pit",
  "reservations",
  "sales",
  "signage",
  "videos",
  "web-sales",
]);

/** Trailing slashes are not significant ("/pit/" is "/pit"); the root path
 *  keeps its slash. Same rule as apps/web's chrome-routes. */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "") || "/";
  return pathname;
}

/** Framework/static paths the proxied pages reference relatively: the
 *  browser asks THIS domain for them, so they must forward upstream. The
 *  extension test mirrors the asset classes apps/web's own matcher excludes.
 *  Everything here is still behind Vercel Authentication. */
function isAssetPath(p: string): boolean {
  return (
    p === "/favicon.ico" ||
    p.startsWith("/_next/") ||
    p.startsWith("/_vercel/") ||
    p.startsWith("/images/") ||
    p.startsWith("/brand/") ||
    /\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|txt|xml|json|webmanifest|woff2?|mp3|mp4)$/.test(p)
  );
}

export type AdminProxyDecision =
  | { kind: "forward"; pathname: string } // proxy to the upstream, same path
  | { kind: "forward-admin"; pathname: string } // proxy to the tokened admin path
  | { kind: "redirect"; pathname: string } // 307 on THIS domain (query preserved by caller)
  | { kind: "not-found" }; // this domain serves nothing else

/**
 * Route a request on the admin domain. `expectedToken` is ADMIN_CAMERA_TOKEN
 * ("" when unset — every tool URL then fails closed to 404).
 */
export function resolveAdminProxyPath(pathname: string, expectedToken: string): AdminProxyDecision {
  const p = normalize(pathname);

  // 1. Framework assets + API traffic go upstream untouched. /api/admin/*
  //    keeps its ?token= gate on the main deployment; the proxy key header
  //    (added in proxy.ts) rides along as the second credential.
  if (isAssetPath(p)) return { kind: "forward", pathname: p };
  if (p === "/api" || p.startsWith("/api/")) return { kind: "forward", pathname: p };

  // 2. Real-token page URLs normalize to the clean form, so the handful of
  //    in-app /admin/${token}/… links (deals→web-sales, the briefing room
  //    switcher, the daily-events shims' targets) land back on clean urls.
  if (expectedToken && p.startsWith(`/admin/${expectedToken}/`)) {
    return { kind: "redirect", pathname: p.slice(`/admin/${expectedToken}`.length) };
  }

  // 3. Everything else under /admin forwards to the main deployment's
  //    unified gate, which already owns embed HMAC, the legacy
  //    ADMIN_ETICKETS_TOKEN 308, and the wrong-token fail-closed 404.
  if (p === "/admin" || p.startsWith("/admin/")) return { kind: "forward", pathname: p };

  // 4. /daily-events is a redirect shim on the main deployment (v1 deleted
  //    2026-07-13). Map it clean→clean HERE so the page shim never runs for
  //    this domain — its redirect() would put the real admin token in a
  //    browser-visible Location header. Deeper /daily-events/{projectId}
  //    deep links still ride the shim (rare bookmark path).
  if (p === "/daily-events") return { kind: "redirect", pathname: "/daily-events-v2" };

  // 5. Staff-preview passthroughs (owner-approved): admin boards link to a
  //    guest's contract (/contract/{shortId}) and voucher (/v/{code}) —
  //    public read-only pages, additionally behind Vercel login here. A bare
  //    /v is deliberately NOT registered (no route exists upstream).
  if (p === "/contract" || p.startsWith("/contract/") || p.startsWith("/v/")) {
    return { kind: "forward", pathname: p };
  }

  // 6. Clean tool URLs → the tokened admin path on the main deployment.
  //    Fails closed when ADMIN_CAMERA_TOKEN is unset.
  const seg = p.split("/")[1] ?? "";
  if (expectedToken && ADMIN_TOOL_SLUGS.has(seg)) {
    return { kind: "forward-admin", pathname: `/admin/${expectedToken}${p}` };
  }

  // 7. Root and every other path: the admin domain serves nothing else.
  return { kind: "not-found" };
}
