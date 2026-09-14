/**
 * `listDeals` — the one call Pipeline, Contracts and Events make.
 *
 * They differ only in the scope and window they ask for, which is the whole
 * point of "one record, three lenses" (BUILD-BRIEF §B.15). When they were three
 * separate queries they disagreed: 177 open contracts, 71 with a lead, so 106
 * were on one screen and missing from the other.
 */

import { isDbConfigured, sql } from "@ft/db";
import {
  OFFICE_ID_ALIASES,
  OFFICE_NAME_ALIASES,
  buildRepIndex,
  toDeal,
  type RepIndex,
  type RepMatchRow,
  type DealRowRaw,
} from "../projection";
import type { Deal } from "../contracts";
import {
  countDealRows,
  queryDealRows,
  type DealFilter,
  type RepFilterKeys,
} from "../data/deals-db";
import { ensureDealSchemas } from "../transport";

/**
 * The roster, read once per request and handed to every row.
 *
 * `toDeal` resolves a deal's planner from BMI's `responsible` when no lead owns
 * it, and that match needs the whole roster — per-centre Office ids included,
 * because the same person is a different id at each centre and the roster
 * column only holds the Fort Myers one.
 */
export async function loadRepIndex(): Promise<RepIndex> {
  if (!isDbConfigured()) return buildRepIndex([]);
  const q = sql();
  const rows = (await q`
    SELECT id::text AS id, slug,
           display_name AS "displayName", first_name AS "firstName", initials, email,
           bmi_user_id AS "bmiUserId", bmi_username AS "bmiUsername"
      FROM crm_reps
     WHERE active IS TRUE
     ORDER BY sort_order, slug
  `) as RepMatchRow[];
  return buildRepIndex(rows);
}

/**
 * Turn a rep slug into everything that can identify them on a deal: our own
 * row id, their Office user id at EVERY centre, and the names Office writes.
 *
 * All three are needed because a deal may be owned through our lead, through
 * BMI's `responsible` id, or through a display name that does not match ours —
 * Office writes "Lori Coates-Lehman" where the roster holds "Lori Lehman", and
 * "CallCenter" where we say "Guest Services".
 */
export function repFilterKeys(reps: RepIndex, slug: string | null): RepFilterKeys | null {
  if (!slug) return null;
  const rep = reps.bySlug.get(slug);
  if (!rep) return null;
  const officeIds = new Set<string>();
  if (rep.bmiUserId) officeIds.add(rep.bmiUserId);
  // The SAME person is a different Office id at each centre, and the roster
  // column only carries Fort Myers — so the per-centre aliases are added too or
  // a Naples deal matches nobody.
  for (const [officeId, s] of Object.entries(OFFICE_ID_ALIASES)) {
    if (s === slug) officeIds.add(officeId);
  }
  const names = new Set<string>();
  if (rep.bmiUsername) names.add(rep.bmiUsername.toLowerCase());
  if (rep.displayName) names.add(rep.displayName.toLowerCase());
  if (rep.firstName) names.add(rep.firstName.toLowerCase());
  for (const [name, s] of Object.entries(OFFICE_NAME_ALIASES)) {
    if (s === slug) names.add(name);
  }
  return {
    repId: rep.id,
    officeIds: [...officeIds],
    officeNames: [...names],
    email: rep.email?.toLowerCase() ?? null,
  };
}

/** Convenience for a caller that has a slug and wants the WHERE fragment. */
export function repWhere(reps: RepIndex, slug: string | null): RepFilterKeys | null {
  return repFilterKeys(reps, slug);
}

export interface ListDealsOptions extends Omit<DealFilter, "rep"> {
  /** `crm_reps.slug`; resolved to every id and name that can own a deal. */
  repSlug?: string | null;
  /** Skip the count when the caller does not paginate. */
  withTotal?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListDealsResult {
  deals: Deal[];
  total: number | null;
  reps: RepIndex;
}

export async function listDeals(
  opts: ListDealsOptions = { scope: "board" },
): Promise<ListDealsResult> {
  if (!isDbConfigured()) return { deals: [], total: 0, reps: buildRepIndex([]) };
  // All three tables must exist before a join over them runs; a fresh database
  // would otherwise answer "relation does not exist" rather than an empty list.
  await ensureDealSchemas();

  const reps = await loadRepIndex();
  const { repSlug, withTotal, limit, offset, ...rest } = opts;
  const filter: DealFilter = { ...rest, rep: repFilterKeys(reps, repSlug ?? null) };

  const [rows, total] = await Promise.all([
    queryDealRows({ filter, limit, offset }),
    withTotal ? countDealRows(filter) : Promise.resolve(null),
  ]);

  return {
    deals: (rows as DealRowRaw[]).map((r) => toDeal(r, { reps })),
    total,
    reps,
  };
}
