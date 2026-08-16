/**
 * Admin-deployment route registry — the ONE place that answers "what does a
 * path serve on the ADMIN Vercel project?".
 *
 * Two Vercel projects build this same app from the same repo root:
 *
 *   1. The main project — fasttraxent.com / headpinz.com, everything public.
 *   2. The admin project — sits behind Vercel Authentication and sets
 *      ADMIN_DEPLOYMENT=1. There, staff tools are served at CLEAN urls
 *      (/pit, /videos, /daily-events-v2, …) by rewriting to the existing
 *      /admin/{ADMIN_CAMERA_TOKEN}/* pages with the token injected
 *      server-side. Every non-admin path 404s (plus the two staff-preview
 *      passthroughs below). The main project never enters this module's
 *      branch in middleware.ts — the env var is unset there, and a guest
 *      host is refused even if it leaks (see isGuestHost).
 *
 * Rules for changing this file:
 *   - Keep it dependency-free and pure — imported by the edge middleware, so
 *     no `process.env`, no feature modules. The env reads live in
 *     middleware.ts; this module only maps (pathname, token) → decision.
 *   - ADMIN_TOOL_SLUGS is pinned to the real app/admin/[token]/* directories
 *     by admin-deployment.test.ts — adding tool #22 without updating the
 *     allowlist fails CI, exactly like the chrome-routes drift pins.
 */

/** The staff tools under app/admin/[token]/ — first path segment of every
 *  clean admin URL. Deeper segments ride along (/camera-assign/blue,
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

/** Production guest domains. The admin block in middleware.ts refuses to run
 *  on these even with ADMIN_DEPLOYMENT set — so a mis-copied env var on the
 *  main project can never expose token-less admin pages to customer traffic.
 *  Corollary: the admin project's domain must NOT be a subdomain of any of
 *  these (use the *.vercel.app domain or a dedicated apex) — and must not be
 *  anyway, because middleware brand detection keys on "headpinz.com". */
const GUEST_DOMAINS = ["fasttraxent.com", "headpinz.com", "swflpassport.com"];

/** host = hostname with any port stripped, lowercased (middleware computes
 *  this once at the top). */
export function isGuestHost(host: string): boolean {
  return GUEST_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Trailing slashes are not significant ("/pit/" is "/pit"); the root path
 *  keeps its slash. Same rule as chrome-routes. */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "") || "/";
  return pathname;
}

export type AdminDeploymentDecision =
  | { kind: "passthrough" } // existing middleware logic handles it
  | { kind: "redirect"; pathname: string } // 307 to the clean form (query preserved by caller)
  | { kind: "rewrite"; pathname: string } // serve the tokened page at the clean URL
  | { kind: "not-found" }; // this project serves nothing else

/**
 * Route a request on the admin deployment. `expectedToken` is
 * ADMIN_CAMERA_TOKEN ("" when unset — everything tokened then fails closed).
 */
export function resolveAdminDeploymentPath(
  pathname: string,
  expectedToken: string,
): AdminDeploymentDecision {
  const p = normalize(pathname);

  // 1. All API traffic untouched: /api/admin/* keeps its ?token= /
  //    x-admin-token gate, /api/cron/* is killed inside verifyCron, and the
  //    queue consumers stay live for admin-originated enqueues.
  if (p === "/api" || p.startsWith("/api/")) return { kind: "passthrough" };

  // 2. Real-token page URLs normalize to the clean form, so the handful of
  //    in-app /admin/${token}/… links (deals→web-sales, the briefing room
  //    switcher, the daily-events shims' redirect targets) land on clean urls.
  if (expectedToken && p.startsWith(`/admin/${expectedToken}/`)) {
    return { kind: "redirect", pathname: p.slice(`/admin/${expectedToken}`.length) };
  }

  // 3. Everything else under /admin falls through to the unified gate in
  //    middleware.ts, which already owns embed HMAC, the legacy
  //    ADMIN_ETICKETS_TOKEN 308, and the wrong-token fail-closed 404. A bare
  //    /admin/<token> (no tool segment) passes the gate into Next's
  //    not-found — the same dead end it is on the main project.
  if (p === "/admin" || p.startsWith("/admin/")) return { kind: "passthrough" };

  // 4. /daily-events is a redirect shim on the main project (v1 was deleted
  //    2026-07-13). Map it clean→clean HERE so the page shim never runs on
  //    this host — its redirect() would put the real admin token in a
  //    browser-visible Location header. Deeper /daily-events/{projectId}
  //    deep links still ride the shim (rare bookmark path).
  if (p === "/daily-events") return { kind: "redirect", pathname: "/daily-events-v2" };

  // 5. Staff-preview passthroughs (owner-approved): admin boards link to a
  //    guest's contract (/contract/{shortId}) and voucher (/v/{code}) —
  //    public read-only pages, additionally behind Vercel login here. A bare
  //    /v is deliberately NOT registered (no route exists; see the /w note
  //    in middleware.ts).
  if (p === "/contract" || p.startsWith("/contract/") || p.startsWith("/v/")) {
    return { kind: "passthrough" };
  }

  // 6. Clean tool URLs → the real tokened path. Fails closed when
  //    ADMIN_CAMERA_TOKEN is unset — same posture as the unified gate.
  const seg = p.split("/")[1] ?? "";
  if (expectedToken && ADMIN_TOOL_SLUGS.has(seg)) {
    return { kind: "rewrite", pathname: `/admin/${expectedToken}${p}` };
  }

  // 7. Root and every other path: the admin project serves nothing else.
  return { kind: "not-found" };
}
