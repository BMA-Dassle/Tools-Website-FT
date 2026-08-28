/**
 * The ONE answer to "is this admin API request authenticated?" for route
 * handlers.
 *
 * WHY IT EXISTS. `middleware.ts` gates every `/api/admin/*` path, but ~45 route
 * handlers ALSO check the credential themselves — deliberate defense in depth,
 * because these routes cancel reservations, refund cards and put text on a wall
 * in front of guests, and a future matcher change must not silently open them.
 * Each of those checks was its own copy of `token === process.env.ADMIN_CAMERA_TOKEN`.
 *
 * That copy-per-route is exactly what made the static token impossible to get
 * out of browsers: the moment a page hands its client a SIGNED, short-lived
 * token instead (lib/admin-api-token.ts), forty-five inline comparisons say
 * 401. So the comparison moved here, once, and learned the other credentials
 * the gate already accepts.
 *
 * WHAT COUNTS AS A CREDENTIAL (same set the middleware accepts, minus the
 * embed HMAC and the api-key allowlist, which are path-scoped and decided
 * there):
 *   1. the static ADMIN_CAMERA_TOKEN — crons, .bat scripts, and any staff
 *      bookmark that still carries it;
 *   2. a signed short-lived API token — what staff browsers now hold;
 *   3. the shell's ADMIN_PROXY_KEY header — what keeps working after the
 *      static token is rotated to a machine-only value.
 *
 * This is still a REAL check, not a "the middleware said so" header sniff: a
 * forged `x-admin-route: 1` proves nothing here, and every path verifies an
 * actual secret. Async because signature verification is Web Crypto.
 */

import { verifyAdminApiToken } from "./admin-api-token";

/** Constant-time compare — never `===` on a credential. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** True for the static ADMIN_CAMERA_TOKEN. Fails closed when the env is unset. */
export function isStaticAdminToken(token: string | null | undefined): boolean {
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || !token) return false;
  return timingSafeEqual(token, expected);
}

/**
 * True when `token` is EITHER the static admin token or a valid signed
 * short-lived one. This is the drop-in replacement for the inline
 * `token === process.env.ADMIN_CAMERA_TOKEN` comparisons — including the
 * handful of routes that read their token out of the POST body.
 */
export async function isAdminCredential(token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  if (isStaticAdminToken(token)) return true;
  return verifyAdminApiToken(token);
}

/** True for the staff shell's shared-secret header. Inert until the env is set. */
export function hasAdminProxyKey(req: { headers: { get(name: string): string | null } }): boolean {
  const expected = process.env.ADMIN_PROXY_KEY || "";
  if (!expected) return false;
  return timingSafeEqual(req.headers.get("x-admin-proxy-key") || "", expected);
}

/**
 * Full check for a route handler: the shell's proxy key, or a token taken from
 * (in order) an explicit argument — for the body-carrying routes — then the
 * `x-admin-token` header, then `?token=`. Same places the middleware looks, so
 * a request the gate let through is a request a route accepts.
 */
export async function isAdminApiRequest(
  req: { headers: { get(name: string): string | null }; url: string },
  opts?: { token?: string | null },
): Promise<boolean> {
  if (hasAdminProxyKey(req)) return true;
  if (opts && "token" in opts) return isAdminCredential(opts.token);
  const header = req.headers.get("x-admin-token");
  if (header) return isAdminCredential(header);
  let query: string | null = null;
  try {
    query = new URL(req.url).searchParams.get("token");
  } catch {
    query = null;
  }
  return isAdminCredential(query);
}
