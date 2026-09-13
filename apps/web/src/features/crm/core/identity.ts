/**
 * Who is using the CRM (brief §3.3).
 *
 * Built on the EXISTING admin SSO and nothing else: `auth()` from `@/auth`
 * (Auth.js v5, provider `headpinz`), `hasAdminAccess` (the `access` role) and
 * the two Entra app roles the gateway strips to `sales` and `sales-director`.
 *
 *   roles has "sales-director"  → director (Jacob, Eric)
 *   else roles has "sales"      → rep
 *   else                        → no access (pages 404, routes 403)
 *
 * IDENTITY KEY = LOWERCASED EMAIL → `crm_rep_logins` → `crm_reps`. `sub` (the
 * Entra oid) is carried for storage, never used to decide anything. A rep row
 * is OPTIONAL: a director with no row still has full access; a `sales` user
 * with no row is let in and sees an empty board plus a director-visible chip,
 * which beats a 404 that hides a seed problem.
 *
 * TWO ENTRY POINTS, ONE RESOLVER:
 *   - `requireCrmUser()` for pages: `notFound()` on anything short of a sales
 *     role — the same opaque 404 `requireSsoAdmin()` gives (an admin URL is
 *     indistinguishable from a typo).
 *   - `crmUserFromRequest()` for route handlers: NEVER throws. No session (or
 *     `auth()` rejecting on a broken env block) → 401; a session without a
 *     sales role → 403. A Neon failure while looking up the rep row degrades to
 *     `rep: null` rather than refusing the request.
 */

import { notFound } from "next/navigation";
import { auth, hasAdminAccess } from "@/auth";
import { findRepByLoginEmail } from "~/features/crm/reps";
import type { PublicCrmUser, PublicRep } from "./contracts";
import type { CrmRep, CrmRole, CrmUser } from "./types";

/** Gateway-stripped Entra app roles (`fasttrax-admin.sales` → `sales`). */
export const SALES_ROLE = "sales";
export const SALES_DIRECTOR_ROLE = "sales-director";

export type CrmUserResolution = { ok: true; user: CrmUser } | { ok: false; status: 401 | 403 };

/** The CRM role implied by a cookie's roles, or null for "no CRM access". */
export function crmRoleFromRoles(roles: readonly string[] | null | undefined): CrmRole | null {
  if (!Array.isArray(roles)) return null;
  if (roles.includes(SALES_DIRECTOR_ROLE)) return "director";
  if (roles.includes(SALES_ROLE)) return "rep";
  return null;
}

export function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

async function resolve(): Promise<CrmUserResolution> {
  const session = await auth().catch(() => null);
  if (!session) return { ok: false, status: 401 };

  // No address = nobody to record as actor_email. Treated as "not signed in"
  // rather than "forbidden": the gateway always sends email or upn, so this is
  // a broken session, not a person without a role.
  const email = normalizeEmail(session.user?.email);
  if (!email) return { ok: false, status: 401 };

  const roles = Array.isArray(session.roles) ? [...session.roles] : [];
  if (!hasAdminAccess(session)) return { ok: false, status: 403 };
  const role = crmRoleFromRoles(roles);
  if (!role) return { ok: false, status: 403 };

  let rep: CrmRep | null = null;
  try {
    rep = await findRepByLoginEmail(email);
  } catch (err) {
    console.warn("[crm] rep lookup failed; continuing without a rep row", {
      email,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const sub = typeof session.sub === "string" && session.sub ? session.sub : null;
  const name = (typeof session.user?.name === "string" && session.user.name) || email;
  return { ok: true, user: { email, name, sub, roles, role, rep } };
}

/** Route handlers. Never throws. */
export async function crmUserFromRequest(): Promise<CrmUserResolution> {
  try {
    return await resolve();
  } catch {
    return { ok: false, status: 401 };
  }
}

/** Pages. 404s (never 401/403) on anything short of a sales role. */
export async function requireCrmUser(): Promise<CrmUser> {
  const r = await crmUserFromRequest();
  if (!r.ok) notFound();
  return r.user;
}

export function isDirector(user: Pick<CrmUser, "role">): boolean {
  return user.role === "director";
}

/** The rep fields a browser may see — no DIDs, chat ids or Office usernames. */
export function publicRep(rep: CrmRep | null): PublicRep | null {
  if (!rep) return null;
  return {
    id: String(rep.id),
    slug: rep.slug,
    displayName: rep.displayName,
    firstName: rep.firstName,
    initials: rep.initials,
    role: rep.role,
    centres: [...rep.centres],
  };
}

/** The wire shape of the signed-in user (`GET /me`, the `CrmApp` prop). */
export function publicUser(user: CrmUser): PublicCrmUser {
  return {
    email: user.email,
    name: user.name,
    role: user.role,
    roles: [...user.roles],
    rep: publicRep(user.rep),
  };
}
