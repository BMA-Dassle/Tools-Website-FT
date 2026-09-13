/**
 * Which salesperson does a mirrored Office project belong to?
 *
 * PURE. The caller hands in the roster and the mirror rows; nothing here reads
 * Neon or Office.
 *
 * OFFICE USER IDS ARE PER TENANT (brief §5.7b, probed live 2026-09-13 13:30
 * against `officeGet(clientKey, "metadata").users[]`). `crm_reps.bmi_user_id`
 * holds ONE id — the Fort Myers one — so a Naples project attributed through
 * it matches NOTHING, which is exactly the bug §5.7b names: "KPI/accountability
 * attribution at Naples matches NOTHING today, because it looks for the Fort
 * Myers id in a tenant that has never heard of it."
 *
 * B1's fix stage owns the `crm_reps.bmi_user_ids JSONB` column and the
 * `bmiUserIdFor(rep, clientKey)` helper. It has not landed, and C7 may not add
 * a column to another sub's table (brief §4). So the probed table below is
 * carried HERE, as C7-owned data, pinned value-for-value by
 * `attribution.test.ts` against §5.7b. When the column lands, `officeUserIdFor`
 * becomes a one-line call to `bmiUserIdFor` and this constant is deleted; the
 * index it feeds does not change shape.
 *
 * Order of resolution, per §1.10:
 *   1. EXACT — (clientKey, responsibleUserId) in the per-tenant table, or the
 *      rep's own `bmiUserId` when the tenant is Fort Myers.
 *   2. FUZZY — the project's `responsible_name` against the rep's
 *      `bmiUsername` / `displayName` / first name. Flagged, never silent: the
 *      KPI response carries the exact/fuzzy/none split and the screen prints it.
 *   3. NONE — counted, and reported, never quietly folded into somebody's total.
 *
 * `mkt` (the Marketing Director hold row) has no Office user in either tenant
 * and must never gain one by a name match: it is not an assignable rep.
 */

import type { CrmRep, OfficeClientKey } from "~/features/crm/core/types";
import type { AttributionCoverage, AttributionKind } from "../contracts";

/**
 * The complete, probed mapping (brief §5.7b). Beware the near-misses that must
 * NOT be matched: Fort Myers has `StephanieT` 31983047 and an inactive
 * "Stephanie Medina"; Naples has `StephanieT` 6790499 and `Stephen` 41146.
 */
export const OFFICE_USER_IDS: Readonly<
  Record<string, Readonly<Partial<Record<OfficeClientKey, string>>>>
> = Object.freeze({
  eric: Object.freeze({ headpinzftmyers: "75262", headpinznaples: "25228" }),
  lori: Object.freeze({ headpinzftmyers: "465247", headpinznaples: "41096" }),
  stephanie: Object.freeze({ headpinzftmyers: "465242", headpinznaples: "1559644" }),
  jacob: Object.freeze({ headpinzftmyers: "7251049", headpinznaples: "3690605" }),
  kelsea: Object.freeze({ headpinzftmyers: "28267036", headpinznaples: "6338800" }),
  gs: Object.freeze({ headpinzftmyers: "30080112", headpinznaples: "6400642" }),
});

/** Naples's web-booking pseudo-user (22 projects); never a salesperson. */
export const ONLINE_PSEUDO_USER_IDS: readonly string[] = ["-6"];

/** Rep slugs that may never be attributed a project, however the name reads. */
const NEVER_ATTRIBUTED = new Set(["mkt"]);

/**
 * The rep's Office user id in ONE tenant, or null.
 *
 * Falls back to `crm_reps.bmi_user_id` ONLY for `headpinzftmyers` — that column
 * holds the Fort Myers value, and handing it to Naples is the write hazard
 * §5.7b describes. A null here means "we do not know this rep's id in this
 * tenant": attribute by name and say so, never guess.
 */
export function officeUserIdFor(rep: CrmRep, clientKey: OfficeClientKey): string | null {
  if (NEVER_ATTRIBUTED.has(rep.slug)) return null;
  const mapped = OFFICE_USER_IDS[rep.slug]?.[clientKey];
  if (mapped) return mapped;
  if (clientKey === "headpinzftmyers" && rep.bmiUserId) return rep.bmiUserId;
  return null;
}

/** A name reduced to letters and single spaces, for the fuzzy arm only. */
export function nameKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface AttributionMatch {
  rep: CrmRep | null;
  kind: AttributionKind;
}

export interface AttributionIndex {
  /** `${clientKey}:${officeUserId}` → rep. */
  byId: Map<string, CrmRep>;
  /** normalised responsible NAME → rep; only when exactly one rep claims it. */
  byName: Map<string, CrmRep>;
  match(
    clientKey: string,
    responsibleUserId: string | null,
    responsibleName: string | null,
  ): AttributionMatch;
}

const CLIENT_KEYS: readonly OfficeClientKey[] = ["headpinzftmyers", "headpinznaples"];

/**
 * Build the index once per request and reuse it for every row.
 *
 * A name that two reps could claim ("Stephanie" when both Stephanie Wegman and
 * a StephanieT exist on the tenant) is dropped from `byName` rather than
 * awarded to the first — an ambiguous name is `none`, which shows up in the
 * coverage line, instead of a wrong number nobody can see.
 */
export function buildAttributionIndex(reps: readonly CrmRep[]): AttributionIndex {
  const byId = new Map<string, CrmRep>();
  const nameOwners = new Map<string, Set<string>>();
  const nameRep = new Map<string, CrmRep>();

  for (const rep of reps) {
    if (NEVER_ATTRIBUTED.has(rep.slug)) continue;
    for (const ck of CLIENT_KEYS) {
      const id = officeUserIdFor(rep, ck);
      if (id) byId.set(`${ck}:${id}`, rep);
    }
    for (const candidate of [rep.bmiUsername, rep.displayName]) {
      const key = nameKey(candidate);
      if (!key) continue;
      const owners = nameOwners.get(key) ?? new Set<string>();
      owners.add(rep.slug);
      nameOwners.set(key, owners);
      nameRep.set(key, rep);
    }
  }

  const byName = new Map<string, CrmRep>();
  for (const [key, owners] of nameOwners) {
    if (owners.size !== 1) continue;
    const rep = nameRep.get(key);
    if (rep) byName.set(key, rep);
  }

  return {
    byId,
    byName,
    match(clientKey, responsibleUserId, responsibleName) {
      if (responsibleUserId) {
        if (ONLINE_PSEUDO_USER_IDS.includes(responsibleUserId)) return { rep: null, kind: "none" };
        const exact = byId.get(`${clientKey}:${responsibleUserId}`);
        if (exact) return { rep: exact, kind: "exact" };
      }
      const key = nameKey(responsibleName);
      if (key) {
        const fuzzy = byName.get(key);
        if (fuzzy) return { rep: fuzzy, kind: "fuzzy" };
      }
      return { rep: null, kind: "none" };
    },
  };
}

export function emptyCoverage(): AttributionCoverage {
  return { projects: 0, exact: 0, fuzzy: 0, none: 0 };
}

export function countCoverage(coverage: AttributionCoverage, kind: AttributionKind): void {
  coverage.projects += 1;
  coverage[kind] += 1;
}
