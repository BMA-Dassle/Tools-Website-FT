/**
 * The roster as the boards use it: every active rep in display order, and the
 * public projection a browser may see (no DIDs, chat ids, Office usernames —
 * `publicRep` in `core/projections.ts` is the ONE projection; re-exported here
 * so callers of the roster never reach into identity for it).
 */

import { publicRep } from "~/features/crm/core/projections";
import type { PublicRep } from "~/features/crm/core/contracts";
import type { CrmRep, RepRole } from "~/features/crm/core/types";
import { listReps } from "../data/reps-db";

export { publicRep };

export interface RosterFilter {
  includeInactive?: boolean;
  /** Only these roles; default every role. */
  roles?: readonly RepRole[];
}

export async function listRoster(filter: RosterFilter = {}): Promise<CrmRep[]> {
  const reps = await listReps({ includeInactive: filter.includeInactive });
  return filter.roles ? reps.filter((r) => filter.roles!.includes(r.role)) : reps;
}

/** The wire shape of the roster. */
export async function publicRoster(filter: RosterFilter = {}): Promise<PublicRep[]> {
  const reps = await listRoster(filter);
  return reps.map((r) => publicRep(r)!).filter(Boolean);
}

/** Reps a lead can be ASSIGNED to (people and the Guest Services bucket, not the Marketing hold). */
export function assignableReps(reps: readonly CrmRep[]): CrmRep[] {
  return reps.filter((r) => r.active && (r.role === "rep" || r.role === "bucket"));
}

export function repBySlug(reps: readonly CrmRep[], slug: string): CrmRep | null {
  return reps.find((r) => r.slug === slug) ?? null;
}
