import { notFound } from "next/navigation";
import { auth, hasAdminAccess } from "@/auth";

/**
 * Defence in depth for the v2 admin pages: the middleware already refused
 * anyone without an `access` session, and every `/admin/<tool>/page.tsx` asks
 * again from inside the server component.
 *
 * WHY ASK TWICE. Every v1 `/admin/{token}/*` page re-checks the token the
 * middleware just checked, and for the same reason: a matcher edit, a rewrite,
 * or a future `next.config` redirect that bypassed the gate would otherwise
 * open every board silently. The pages that mutate reservations, refund cards
 * and put text on a wall in front of guests do not get to rely on one gate.
 *
 * 404, NOT 403. Same opaque answer as the token gate — an admin URL is
 * indistinguishable from a typo, so a scanner learns nothing from a probe.
 * The person who is merely signed out never sees this: the middleware sent
 * them to `/sso/signin` before the page ran.
 *
 * FAILS CLOSED ON A THROW. `auth()` throws when the SSO env block is
 * incomplete, so an unconfigured deployment 404s the boards rather than
 * rendering them with no session at all.
 */
export async function requireSsoAdmin(): Promise<void> {
  const session = await auth().catch(() => null);
  if (!hasAdminAccess(session)) notFound();
}
