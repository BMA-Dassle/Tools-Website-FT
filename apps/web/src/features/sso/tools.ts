/**
 * The admin-host routing table — what a path DOES on `admin.fasttraxent.com`,
 * and whether a `/admin/<seg>/…` path is one the SSO gate owns.
 *
 * BACKGROUND. Staff used to reach the boards through a separate Next project
 * (`apps/admin`) that authenticated the person with Microsoft and then proxied
 * every request to THIS deployment with `ADMIN_CAMERA_TOKEN` injected into the
 * path. That shell was the answer to a different wall: it existed to get off
 * Vercel Authentication, and once a real OIDC gateway existed the extra
 * deployment bought nothing and cost a second env block, a shared proxy key,
 * and a routing table drift-pinned to this app's directory listing. So this
 * module is the shell's `src/routes.ts` moved in-process — same decisions, no
 * second deployment, no network hop.
 *
 * WHICH LIST GATES WHAT lives in `~/lib/constants/admin-tools`, not here. This
 * module maps (host, pathname) → decision and nothing else.
 *
 * Rules for changing this file:
 *   - Keep it dependency-free and pure — imported by the EDGE middleware, so no
 *     `process.env`, no Node APIs, no `next/*` imports. Env reads live in
 *     middleware.ts.
 *   - Every behaviour here is pinned by `tools.test.ts` and the golden matrix
 *     in `middleware.admin-gate.test.ts`.
 */

import {
  ADMIN_EMBED_SEGMENT,
  ADMIN_TOOL_SLUGS,
  SSO_ADMIN_TOOLS,
} from "~/lib/constants/admin-tools";

export { ADMIN_EMBED_SEGMENT, ADMIN_TOOL_SLUGS, SSO_ADMIN_TOOLS };

/** The staff domain. The alias points at THIS project (see admin-url.ts). */
export const DEFAULT_ADMIN_HOST = "admin.fasttraxent.com";

/**
 * Hosts that serve the admin tools at clean URLs. `admin.fasttraxent.com` is
 * hard-coded because it is the one permanent answer; anything else — a preview
 * alias, a future `admin.headpinz.com` — comes from `ADMIN_HOSTS`
 * (comma-separated) so a deploy-specific hostname never gets baked into source.
 *
 * `hosts` is the parsed `ADMIN_HOSTS` value; the caller reads the env because
 * this module must stay pure.
 */
export function isAdminHost(host: string, hosts: readonly string[] = []): boolean {
  const h = host.split(":")[0].toLowerCase();
  if (!h) return false;
  if (h === DEFAULT_ADMIN_HOST) return true;
  return hosts.some((candidate) => candidate.split(":")[0].toLowerCase() === h);
}

/** `ADMIN_HOSTS="a.example, b.example"` → `["a.example","b.example"]`. */
export function parseAdminHosts(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/** Trailing slashes are not significant ("/pit/" is "/pit"); the root keeps
 *  its slash. Same rule as the chrome-routes registry. */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "") || "/";
  return pathname;
}

/** Framework/static paths the pages reference relatively. */
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

/**
 * The routes the SSO plumbing serves itself. They must be decided BEFORE the
 * `/api/` pass below, or the sign-in callback (`/api/auth/callback/headpinz`)
 * would be treated as ordinary API traffic; and they must be reachable WITHOUT
 * a session, because gating the sign-in route on being signed in is an infinite
 * redirect.
 */
export function isSsoSelfPath(pathname: string): boolean {
  const p = normalize(pathname);
  return p === "/api/auth" || p.startsWith("/api/auth/") || p === "/sso" || p.startsWith("/sso/");
}

export type AdminHostDecision =
  | { kind: "self" } // Auth.js + the /sso surfaces — never gated
  | { kind: "pass" } // serve the path as-is on this host
  | { kind: "tool"; pathname: string } // SSO-gated, rewrite to /admin/<slug>…
  | { kind: "legacy-tool"; slug: string; path: string } // SSO-gated, rewrite to the tokened path
  | { kind: "not-found" }; // the admin host serves nothing else

/**
 * Route a request that arrived on an admin host.
 *
 * The FastTrax/HeadPinz storefront answers on the same deployment, so the
 * default is 404, not "serve it": a guest route rendering on the staff domain
 * would put the booking funnel behind a Microsoft sign-in wall and split every
 * canonical URL in two.
 *
 * WHY THERE ARE TWO KINDS OF TOOL. `admin.fasttraxent.com/deals` has worked for
 * months — first proxied by the shell to `/admin/{ADMIN_CAMERA_TOKEN}/deals`,
 * now rewritten here — and that URL is in staff email, in Teams cards, and in
 * `adminToolUrl()` output going back just as far. Moving the domain onto this
 * deployment must not break a tool that is not behind sign-in. So a clean tool
 * URL resolves either way:
 *
 *   - `tool` — the slug has a v2 page. Rewrite to `/admin/<slug>`; no
 *     credential in the path at all.
 *   - `legacy-tool` — it does not yet. Rewrite to `/admin/{token}/<slug>`,
 *     which is bit-for-bit what the shell does today, minus the network hop.
 *
 * BOTH are behind the same SSO gate. The difference is only whether the token
 * still appears in the rewritten (server-side, never browser-visible) path —
 * and therefore whether Next serialises it into the RSC payload, which is
 * audit item #8. Moving a slug from one list to the other closes that leak for
 * that tool; the caller decides the gate, this function decides the path.
 */
export function resolveAdminHostPath(pathname: string): AdminHostDecision {
  const p = normalize(pathname);

  // 0. Our own sign-in plumbing. FIRST, ahead of the /api pass —
  //    /api/auth/callback/headpinz is an /api path.
  if (isSsoSelfPath(p)) return { kind: "self" };

  // 1. Framework assets and API traffic serve normally. /api/admin/* keeps its
  //    own credential rules in the unified gate; a board's XHR is authenticated
  //    by the minted API token it was handed, not by the host it came from.
  if (isAssetPath(p)) return { kind: "pass" };
  if (p === "/api" || p.startsWith("/api/")) return { kind: "pass" };

  // 2. Already-canonical admin paths (a bookmark saved from the rewrite, the
  //    portal's embed URLs, a device's tokened board URL) serve as-is; the
  //    unified gate decides them with exactly the rules it uses everywhere.
  if (p === "/admin" || p.startsWith("/admin/")) return { kind: "pass" };

  // 3. Staff-preview passthroughs (owner-approved, ported from the shell's
  //    routing table): admin boards link to a guest's contract
  //    (/contract/{shortId}) and voucher (/v/{code}) with RELATIVE hrefs, so
  //    404ing them here would break a click that works today. Public read-only
  //    pages, additionally behind SSO on this host. A bare /v is deliberately
  //    NOT registered (no route exists).
  if (p === "/contract" || p.startsWith("/contract/") || p.startsWith("/v/")) {
    return { kind: "pass" };
  }

  // 4. Clean tool URLs.
  const seg = p.split("/")[1] ?? "";
  if (SSO_ADMIN_TOOLS.has(seg)) return { kind: "tool", pathname: `/admin${p}` };
  if (ADMIN_TOOL_SLUGS.has(seg)) return { kind: "legacy-tool", slug: seg, path: p };

  // 5. Root and every other path: the admin host serves nothing else.
  return { kind: "not-found" };
}

/**
 * True when `/admin/<seg>/…` names an SSO-gated tool page — a v2 route with no
 * credential in the URL.
 *
 * EXCLUDED, and each exclusion is load-bearing:
 *   - `/api/…` — every `/api/admin/*` path keeps its own credential rules.
 *   - `/admin/embed/*` — the portal's HMAC iframe surface; it has no Microsoft
 *     session and must never be redirected to a sign-in page inside an iframe.
 *   - `/admin/{ADMIN_CAMERA_TOKEN}/…` — belt-and-braces for the (impossible in
 *     practice) case of a token whose value equals a tool slug. The token form
 *     must keep its v1 meaning: staff bookmarks, crons, the two wall displays
 *     and the shell all still use it.
 *   - every slug that is NOT in `SSO_ADMIN_TOOLS` — `pit` and `briefing`
 *     because they are unattended displays that must never be sent to a login
 *     screen, and `camera-assign` because it is worked trackside on shared
 *     kiosks (owner decision 2026-08-28). None of the three has a v2 page to
 *     render.
 */
export function isSsoToolPath(pathname: string, expectedToken: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  const p = normalize(pathname);
  if (!p.startsWith("/admin/")) return false;
  const seg = p.split("/")[2] ?? "";
  if (!seg || seg === ADMIN_EMBED_SEGMENT) return false;
  if (expectedToken && seg === expectedToken) return false;
  return SSO_ADMIN_TOOLS.has(seg);
}
