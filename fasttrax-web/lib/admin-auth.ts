/**
 * Shared auth gate for /admin/* (page) and /api/admin/* (endpoints).
 *
 * Two layered checks, both env-driven:
 *
 *   1. Path token — request must include `ADMIN_ETICKETS_TOKEN` (32-byte
 *      hex). Mismatch returns 404 at the middleware layer so the URL is
 *      indistinguishable from a missing page.
 *
 *   2. IP match — origin IP (leftmost of x-forwarded-for on Vercel) must
 *      be in `ADMIN_ALLOWED_IPS` (comma-separated). Mismatch → 404.
 *
 * This is NOT a login system. It's a bookmarkable bearer URL for front-
 * desk computers + a network-location constraint to block casual leaks.
 *
 * To rotate the token:
 *   1. Generate a new value: `openssl rand -hex 16`
 *   2. Update `ADMIN_ETICKETS_TOKEN` in Vercel env
 *   3. Redeploy
 *   4. Send the new URL to the front desk
 *
 * To add a new IP:
 *   Append to `ADMIN_ALLOWED_IPS` (comma-separated) in Vercel env +
 *   redeploy.
 */

import type { NextRequest } from "next/server";

/** Constant-time string compare to avoid timing leaks on the token check. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Pull the origin IP from Vercel's forwarded headers. Falls back to direct. */
export function getClientIp(req: { headers: { get(name: string): string | null } }): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // leftmost is the original client; rest are Vercel / intermediate proxies
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return null;
}

/** Parse comma-separated allowlist. Empty env → empty set (no one allowed). */
function parseAllowedIps(): Set<string> {
  const raw = process.env.ADMIN_ALLOWED_IPS || "";
  const out = new Set<string>();
  for (const chunk of raw.split(",")) {
    const trimmed = chunk.trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

/** True if `ip` is in the env allowlist. CIDRs not supported yet — bare IPs only. */
export function isIpAllowed(ip: string | null): boolean {
  if (!ip) return false;
  const allowed = parseAllowedIps();
  return allowed.has(ip);
}

/** Validate the provided token against the env var. Constant-time. */
export function isTokenValid(token: string | null | undefined): boolean {
  const expected = process.env.ADMIN_ETICKETS_TOKEN || "";
  if (!expected) return false;        // fail closed if env is unset
  if (!token) return false;
  return timingSafeEqual(token, expected);
}

/**
 * Full admin auth for an API request. Returns true if both the path
 * token (extracted from `?token=...` query, `x-admin-token` header, or a
 * supplied argument) and the origin IP pass.
 *
 * For middleware use, prefer extracting the token from the path segment
 * directly — see middleware.ts.
 */
export function isAdminRequest(
  req: NextRequest,
  opts?: { token?: string },
): boolean {
  // Token from arg > header > query
  const fromArg = opts?.token;
  const fromHeader = req.headers.get("x-admin-token");
  const fromQuery = new URL(req.url).searchParams.get("token");
  const token = fromArg || fromHeader || fromQuery;

  if (!isTokenValid(token)) return false;
  if (!isIpAllowed(getClientIp(req))) return false;
  return true;
}
