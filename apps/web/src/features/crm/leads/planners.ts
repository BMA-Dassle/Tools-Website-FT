/**
 * "Who would you like to work with?" — the planner list the PUBLIC lead form
 * offers, and the pure helpers both sides share.
 *
 * CLIENT-SAFE: type-only imports, no Neon, no Node. `components/SalesLeadForm.tsx`
 * imports it directly by path (the same way it would `./contracts`), and
 * `app/api/sales-lead/planners/route.ts` projects the roster through
 * `plannerOptions`.
 *
 * WHAT A GUEST MAY SEE: a first name and the centres that planner sells at —
 * nothing else. No email, no DID, no Office username, no row id (the form
 * sends the SLUG and the server resolves it against the roster, so a guest can
 * neither learn nor forge a `crm_reps.id`).
 *
 * The options come from the roster at request time, never a hard-coded list:
 * a planner who leaves, or who stops covering a centre, disappears from the
 * form with no deploy.
 */

import type { CentreCode, CrmRep } from "../core/types";

/** The form's `centerKey` prop values (`components/SalesLeadForm.tsx:21-23`). */
export type SalesFormCenterKey = "fasttrax-ft-myers" | "headpinz-ft-myers" | "headpinz-naples";

/** The same mapping `centreForCenterKey` makes server-side, without `resolveCenter`. */
export const CENTER_KEY_TO_CENTRE: Record<SalesFormCenterKey, CentreCode> = {
  "fasttrax-ft-myers": "FT",
  "headpinz-ft-myers": "HPFM",
  "headpinz-naples": "HPN",
};

/** One row of `GET /api/sales-lead/planners`. */
export interface PlannerOption {
  slug: string;
  firstName: string;
  centres: CentreCode[];
}

export interface PlannersResponse {
  ok: true;
  planners: PlannerOption[];
}

/** Where the form reads them from. */
export const PLANNERS_ENDPOINT = "/api/sales-lead/planners";

/** The default choice, and what the form sends when the guest leaves it alone. */
export const FIRST_AVAILABLE_OPTION = "First available";

/** The control's label and helper text — plain, and the form's own voice. */
export const PLANNER_FIELD_LABEL = "Who would you like to work with?";
export const PLANNER_FIELD_HELP =
  "First available is usually quickest. If your pick is away that day, another planner will look after you.";

/**
 * The roster → the public list: people only. The Guest Services bucket, the
 * Marketing Director hold row and the directors are not planners a guest picks
 * (a kids' party reaches Guest Services by rule, not by request), and an
 * inactive row is gone.
 */
export function plannerOptions(reps: readonly CrmRep[]): PlannerOption[] {
  return reps
    .filter((r) => r.active && r.role === "rep" && r.centres.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.firstName.localeCompare(b.firstName))
    .map((r) => ({ slug: r.slug, firstName: r.firstName, centres: [...r.centres] }));
}

/** The options for the centre the guest has actually picked in the form. */
export function plannersForCenterKey(
  planners: readonly PlannerOption[],
  centerKey: string,
): PlannerOption[] {
  const centre = CENTER_KEY_TO_CENTRE[centerKey as SalesFormCenterKey];
  if (!centre) return [];
  return planners.filter((p) => p.centres.includes(centre));
}

/**
 * Is the guest's current pick still on offer? Used to clear the control when
 * they switch centre or change the event type to a kids' birthday, so the form
 * never posts a planner it is no longer showing.
 */
export function plannerStillOffered(
  planners: readonly PlannerOption[],
  centerKey: string,
  slug: string,
): boolean {
  if (!slug) return true;
  return plannersForCenterKey(planners, centerKey).some((p) => p.slug === slug);
}

/** The chip every staff surface shows — "Guest asked for Kelsea". */
export function requestedPlannerLabel(firstName: string): string {
  return `Guest asked for ${firstName}`;
}
