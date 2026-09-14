/**
 * `listDeals` — the read every lens goes through.
 *
 * Pipeline, Contracts and Events call this with a different SCOPE and a
 * different window and get the same record back. Nothing downstream is allowed
 * its own SELECT of these three tables; that is how the two screens ended up
 * disagreeing about what exists in the first place.
 *
 * The roster is fetched once per read and turned into the index the projection
 * uses to name a deal's owner — by the lead's assignee, else Office's
 * `responsible`, else the contract's planner. It is a handful of rows and is
 * cached upstream, so it costs nothing to be right about every row.
 */

import { listReps } from "~/features/crm/reps";
import type { CrmRep } from "../../core/types";
import { DEAL_PAGE_MAX, type Deal, type DealFilter } from "../contracts";
import {
  binder,
  countDealRows,
  queryDealRows,
  repClause,
  type Binder,
  type DealQueryOptions,
  type RepFilterKeys,
} from "../data/deals-db";
import {
  OFFICE_ID_ALIASES,
  OFFICE_NAME_ALIASES,
  buildRepIndex,
  toDeal,
  type RepIndex,
} from "../projection";

export interface ListDealsOptions extends Omit<DealQueryOptions, "filter"> {
  filter: DealFilter;
  /** Supplied by callers that already hold the roster, to skip the round trip. */
  reps?: readonly CrmRep[];
}

export async function loadRepIndex(reps?: readonly CrmRep[]): Promise<RepIndex> {
  const roster = reps ?? (await listReps({ includeInactive: true }).catch(() => []));
  return buildRepIndex(roster);
}

export async function listDeals(opts: ListDealsOptions): Promise<Deal[]> {
  const [index, rows] = await Promise.all([loadRepIndex(opts.reps), queryDealRows(opts)]);
  return rows.map((r) => toDeal(r, { reps: index }));
}

export { countDealRows };

/**
 * The rep filter, resolved from a slug to every id Office might know them by.
 *
 * Returns null when the roster has never heard of the slug, and the caller
 * MUST then return an empty page rather than an unfiltered one: a filter that
 * silently stops filtering is how a salesperson ends up looking at the whole
 * company's board.
 */
export function repFilterKeys(reps: readonly CrmRep[], slug: string): RepFilterKeys | null {
  const rep = reps.find((r) => r.slug === slug);
  if (!rep) return null;
  const officeIds = new Set<string>();
  if (rep.bmiUserId) officeIds.add(rep.bmiUserId);
  for (const [officeId, aliasSlug] of Object.entries(OFFICE_ID_ALIASES)) {
    if (aliasSlug === slug) officeIds.add(officeId);
  }
  const officeNames = new Set<string>();
  if (rep.bmiUsername) officeNames.add(rep.bmiUsername.trim().toLowerCase());
  if (rep.displayName) officeNames.add(rep.displayName.trim().toLowerCase());
  for (const [name, aliasSlug] of Object.entries(OFFICE_NAME_ALIASES)) {
    if (aliasSlug === slug) officeNames.add(name);
  }
  return {
    repId: rep.id,
    officeIds: [...officeIds],
    officeNames: [...officeNames],
    email: rep.email ? rep.email.toLowerCase() : null,
  };
}

/** `repClause` against a slug, or null when the slug is unknown. */
export function repWhere(
  reps: readonly CrmRep[],
  slug: string | undefined,
  b: Binder,
): string | null {
  if (!slug) return "";
  const keys = repFilterKeys(reps, slug);
  return keys ? repClause(keys, b) : null;
}

export { binder, DEAL_PAGE_MAX };
