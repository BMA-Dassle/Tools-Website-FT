import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveAdminProxyPath } from "./src/routes";

/**
 * The staff admin front door. This Vercel project sits behind Vercel
 * Authentication and serves the admin tools at clean URLs (/pit, /videos,
 * /daily-events-v2, …) by proxying every request to the MAIN deployment,
 * which holds all secrets and executes all server code. See src/routes.ts
 * for the routing table and the reasoning.
 *
 * Env (this project only — nothing sensitive):
 *   ADMIN_CAMERA_TOKEN     the main site's current admin token, injected
 *                          into forwarded page paths (fails closed if unset)
 *   ADMIN_PROXY_KEY        shared secret forwarded as x-admin-proxy-key; the
 *                          main gate accepts it as a credential, which is
 *                          what lets the URL token later rotate to a
 *                          machine-only value (optional until then)
 *   ADMIN_UPSTREAM_ORIGIN  override for local dev (defaults to the public
 *                          main site)
 *
 * No matcher config on purpose: the shell owns no assets or routes, so the
 * proxy must see every request — including /_next/* — to forward it.
 */
export default function proxy(request: NextRequest) {
  const upstream = process.env.ADMIN_UPSTREAM_ORIGIN || "https://headpinz.com";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  const proxyKey = process.env.ADMIN_PROXY_KEY || "";

  const decision = resolveAdminProxyPath(request.nextUrl.pathname, expected);

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
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // Same opaque fail-closed body as the main deployment's admin gate.
  return new NextResponse("Not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}
