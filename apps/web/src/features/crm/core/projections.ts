/**
 * Server → wire projections, PURE (no `@/auth`, no Neon), so any sub can
 * import them without pulling identity's session machinery — and without the
 * import cycle `reps → identity → reps` a roster helper would otherwise create.
 * `core/identity.ts` re-exports both, so its surface is unchanged.
 */

import type { PublicCrmUser, PublicRep } from "./contracts";
import type { CrmRep, CrmUser } from "./types";

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
