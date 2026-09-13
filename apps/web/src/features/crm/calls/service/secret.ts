/**
 * The shared secret that guards the two PUBLIC `/api/crm/3cx/*` routes.
 *
 * These are two of exactly three public `/api/crm/**` routes the brief allows
 * (R3), and they are public BY NECESSITY: the 3CX server-side CRM-Integration
 * template calls them from the PBX, which holds no admin session and no cookie.
 *
 * FAILS CLOSED — the whole point of this file. `VOX_MO_TOKEN` guards the Vox
 * inbound webhook and **fails OPEN when unset** (`app/api/sms-webhook/vox/
 * inbound/route.ts`), which means an unset env var silently publishes that
 * endpoint to the internet. We do not repeat that: with `CRM_3CX_SECRET` unset
 * every request is refused 401, and the Calls screen says so out loud
 * ("3CX journaling is not connected yet"). A test pins the unset case.
 *
 * TWO TRANSPORTS, ONE SECRET. Whether the PBX's template can send a custom
 * header could not be settled from the API — `GET /xapi/v1/CrmTemplates` is a
 * 404 for our API user (`docs/crm/3cx.md`) — so both are accepted:
 *   - `x-crm-3cx-secret: <secret>` (preferred), or
 *   - `?k=<secret>`, the shape the Vox webhook already uses and the one a
 *     template variable can always produce.
 * Whichever the owner ends up configuring, the route already takes it.
 *
 * The comparison is length-safe and constant-time, because this is a bearer
 * secret on an unauthenticated endpoint.
 */

import { timingSafeEqual } from "node:crypto";

export const THREECX_SECRET_HEADER = "x-crm-3cx-secret";
export const THREECX_SECRET_QUERY = "k";
export const THREECX_SECRET_ENV = "CRM_3CX_SECRET";

/** Is the secret configured at all? The screen reports this as `journalConfigured`. */
export function threecxSecretConfigured(): boolean {
  return Boolean((process.env[THREECX_SECRET_ENV] || "").trim());
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** The candidate a request offers, header first. */
export function offeredSecret(req: {
  headers: { get(name: string): string | null };
  nextUrl?: { searchParams: URLSearchParams };
  url?: string;
}): string | null {
  const header = req.headers.get(THREECX_SECRET_HEADER);
  if (header && header.trim()) return header.trim();
  const params =
    req.nextUrl?.searchParams ?? (req.url ? new URL(req.url).searchParams : new URLSearchParams());
  const q = params.get(THREECX_SECRET_QUERY);
  return q && q.trim() ? q.trim() : null;
}

/**
 * May this request in? `false` when the env var is unset (fail CLOSED), when no
 * secret was offered, and when the offered one does not match.
 */
export function threecxSecretOk(req: {
  headers: { get(name: string): string | null };
  nextUrl?: { searchParams: URLSearchParams };
  url?: string;
}): boolean {
  const expected = (process.env[THREECX_SECRET_ENV] || "").trim();
  if (!expected) return false;
  const offered = offeredSecret(req);
  if (!offered) return false;
  return constantTimeEqual(offered, expected);
}

/** The 401 body both public routes answer with — no hint about which half failed. */
export function threecxUnauthorized(): Response {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
