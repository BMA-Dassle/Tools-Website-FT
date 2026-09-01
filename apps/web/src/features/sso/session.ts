/**
 * Reading the Auth.js session inside the EDGE middleware.
 *
 * WHY NOT `export default auth(middleware)`. That is what the Auth.js docs
 * show, and it is the wrong shape for this file:
 *
 *   1. `middleware.ts` here answers EVERY request to the storefront — every
 *      booking page, every `/tv` wall board, every kiosk. Wrapping it in
 *      `auth()` would run Auth.js's config validation on all of them, and
 *      Auth.js validates on the first REQUEST, not at build: one missing
 *      `AUTH_SECRET` would take the whole public site to 500, not just the
 *      admin tools. The blast radius of an env mistake has to stay inside
 *      `/admin/*`.
 *   2. `auth.ts` passes a config FACTORY to `NextAuth` (so the config reads the
 *      runtime env). For a function config next-auth's `initAuth` returns an
 *      `async` wrapper, so `auth(handler)` is a PROMISE of the handler, and
 *      Next's middleware loader hard-fails on `typeof handler !== "function"`
 *      — it answered "The Proxy file must export a function…" to every request
 *      in the shell until that was found (apps/admin/proxy.ts). Not importing
 *      the wrapper at all is the version of that fix with nothing left to trip
 *      over; `middleware.contract.test.ts` still pins the export shape.
 *   3. Pulling Auth.js's request handler into the edge bundle costs every guest
 *      page view, to answer a question only `/admin/*` asks.
 *
 * So the middleware decodes the session cookie directly. That is a pure
 * function of (cookie, `AUTH_SECRET`): no network, no provider config, no
 * discovery document, deterministic, and — because `@auth/core/jwt` is built on
 * `jose` — edge-compatible. It fails CLOSED on anything it cannot read.
 *
 * The cookie it reads is the one Auth.js WRITES, so this module and `auth.ts`
 * cannot drift silently: `session.test.ts` encodes a real cookie with
 * `@auth/core/jwt`'s own `encode` and asserts this reads it back.
 */

import { decode } from "@auth/core/jwt";

/** Presence of this role means "may use the FastTrax admin tools". */
export const REQUIRED_ROLE = "access";

/** The claims the admin gate cares about. Never the raw token. */
export interface SsoSession {
  email?: string;
  name?: string;
  roles: string[];
}

/** Auth.js's cookie name, and the salt its encryption key is derived from. */
export const SESSION_COOKIE = "authjs.session-token";
export const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";

/**
 * The cookie names to try, in order, for a request on `protocol`.
 *
 * Auth.js picks the `__Secure-` prefix from the URL's protocol, and the chosen
 * NAME is also the HKDF salt — so a name and its salt must always travel
 * together. Both are tried because the deployed app is https while local dev
 * and the test suite are http, and a request that reaches the edge through a
 * proxy can disagree with the cookie the browser actually holds.
 */
export function sessionCookieNames(protocol: string): readonly string[] {
  return protocol === "https:"
    ? [SECURE_SESSION_COOKIE, SESSION_COOKIE]
    : [SESSION_COOKIE, SECURE_SESSION_COOKIE];
}

/** The minimal cookie reader this module needs — `NextRequest.cookies`. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/**
 * Reassemble one cookie value, chunked or not.
 *
 * Auth.js splits a session cookie larger than 4096 bytes into `name.0`,
 * `name.1`, … Our sessions are small (email, name, one role) so the chunked
 * form is not expected — but "not expected" is how a gate starts 404ing the
 * person with the longest display name.
 */
export function readCookieValue(cookies: CookieReader, name: string): string | null {
  const single = cookies.get(name)?.value;
  if (single) return single;
  let value = "";
  for (let i = 0; ; i += 1) {
    const chunk = cookies.get(`${name}.${i}`)?.value;
    if (!chunk) break;
    value += chunk;
  }
  return value || null;
}

/**
 * The session on this request, or `null`.
 *
 * `null` for: no `AUTH_SECRET`, no cookie, a cookie signed with a retired
 * secret, a tampered cookie, an expired one (`decode` rejects it), and any
 * exception at all. There is deliberately no way for this to throw — a gate
 * that throws is a gate that 500s instead of 404ing.
 */
export async function readSsoSession(request: {
  cookies: CookieReader;
  nextUrl: { protocol: string };
}): Promise<SsoSession | null> {
  const secret = process.env.AUTH_SECRET || "";
  if (!secret) return null;

  for (const name of sessionCookieNames(request.nextUrl.protocol)) {
    const token = readCookieValue(request.cookies, name);
    if (!token) continue;
    try {
      // The name IS the salt — see sessionCookieNames.
      const payload = await decode({ token, secret, salt: name });
      if (payload) return toSession(payload);
    } catch {
      // Wrong salt for this name, wrong secret, or garbage. Try the other name.
    }
  }
  return null;
}

function toSession(payload: Record<string, unknown>): SsoSession {
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((r): r is string => typeof r === "string")
    : [];
  return {
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    roles,
  };
}

/** True when a session may use the admin tools. The ONE authorization rule. */
export function hasSsoAccess(session: { roles?: string[] } | null | undefined): boolean {
  return !!session?.roles?.includes(REQUIRED_ROLE);
}
