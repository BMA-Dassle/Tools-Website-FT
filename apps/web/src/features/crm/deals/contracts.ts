/**
 * THE DEAL — one record, three lenses (BUILD-BRIEF §B.15).
 *
 * A deal is a BMI project with two OVERLAYS hanging off it: the `crm_leads`
 * row that says who is working it, and the `group_function_quotes` row that
 * says what the money is doing. Pipeline, Contracts and Events are three
 * FILTERS over the same read, not three reads.
 *
 * WHY THE PROJECT IS THE SPINE, measured on production 2026-09-13:
 *   5,106 mirrored BMI group events · 559 contracts · 187 leads.
 *   Every lead with a project id has a MIRRORED project (0 exceptions).
 *   491 of 559 contracts have a mirrored project.
 *   4,615 group events have no contract at all.
 * Keying the read on the project therefore loses nothing a lead-keyed read
 * had, and gains every booking the CRM never knew about. Contracts and
 * Pipeline stop disagreeing because they stop being different queries.
 *
 * NOTHING IS EVER SILENTLY DROPPED. The spine is a superset, not a filter: a
 * quote whose project is not in the mirror (68 rows, 11 of them open) and a
 * lead that was minted without one (2 rows) are keyed on their own row id
 * instead, so they still arrive — flagged, never missing. `spine` on every
 * deal says which table supplied its identity, so a screen can show the gap
 * rather than paper over it. We do not write rows to make a screen look full.
 *
 * CLIENT-SAFE: type-only imports, no Node, no Neon. Every id is a string —
 * the BMI project id is 17 digits at Pandora and must never touch `Number()`.
 */

import type { CentreCode, GfStatus, NextAction } from "../core/types";

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/** What BMI holds — the spine. Null only for a deal keyed on a lead or quote. */
export interface DealProject {
  /** `crm_bmi_projects.project_id`, TEXT everywhere. */
  projectId: string;
  clientKey: string;
  locationId: number | null;
  /** The human "H2892". */
  number: string | null;
  name: string | null;
  stateId: string | null;
  stateName: string | null;
  kindId: string | null;
  /** Office's own owner of the project. */
  responsibleUserId: string | null;
  responsibleName: string | null;
  /** YYYY-MM-DD, the calendar day BMI holds. */
  eventDate: string | null;
  eventStart: string | null;
  persons: number | null;
  totalValueCents: number | null;
  balanceCents: number | null;
  personId: string | null;
  personName: string | null;
  personPhone: string | null;
  personEmail: string | null;
  syncedAt: string | null;
}

/** Who is working it — `crm_leads`, joined on `bmi_project_id`. */
export interface DealLead {
  id: string;
  /** `L-225` — the deal drawer's URL key. */
  publicId: string;
  status: string;
  repId: string | null;
  repSlug: string | null;
  repName: string | null;
  assignedAt: string | null;
  firstTouchAt: string | null;
  nextAction: NextAction | null;
  valueCents: number;
  source: string;
  createdBy: string | null;
  createdAt: string;
  /** True for the rows `adoptOpenBmiDeals` wrote — the read no longer needs them. */
  adopted: boolean;
}

/**
 * What the money is doing — `group_function_quotes`, joined on
 * `bmi_reservation_id` and NEVER on `crm_leads.gf_short_id`.
 *
 * `gf_short_id` is NULL on all 187 leads and nothing has ever populated it, so
 * every screen that keyed off it reported "no quote yet" for deals whose
 * contract was one table away (Juniper Landscaping, H2892 / project 47357477,
 * contract e41b6fdf, deposit $2,397.24 paid — the owner's example, 2026-09-13).
 * Both sides already carry the project id. Join on the thing that is there.
 */
export interface DealQuote {
  /** `group_function_quotes.id` as text. */
  quoteId: string;
  /** `contract_short_id` — the key every contract action takes. */
  shortId: string | null;
  status: GfStatus;
  centerCode: string;
  centerName: string;
  eventName: string | null;
  eventNumber: string | null;
  /** YYYY-MM-DD as the quote records it. */
  eventDate: string;
  guestCount: number | null;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string | null;
  approvalRequired: boolean;
  isTaxExempt: boolean;
  totalCents: number;
  taxCents: number;
  depositDueCents: number;
  balanceCents: number;
  collectedCents: number;
  sentAt: string | null;
  signedAt: string | null;
  depositPaidAt: string | null;
  balancePaidAt: string | null;
  balanceLinkSentAt: string | null;
  dayofOrderId: string | null;
  settledOrderId: string | null;
  giftCardGan: string | null;
  savedCardBrand: string | null;
  savedCardLast4: string | null;
  signedPdfUrl: string | null;
  plannerEmail: string | null;
  plannerFirst: string | null;
  plannerLast: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// The deal
// ---------------------------------------------------------------------------

/**
 * Which table gave the deal its IDENTITY.
 *
 * `project` is the normal case and the one the model is built on. The other
 * two exist so the read can be lossless: they are the rows the mirror has not
 * reached, and a screen should say so rather than hide them.
 */
export type DealSpine = "project" | "quote" | "lead";

/** Where the deal's working status came from. */
export type DealStatusSource = "lead" | "bmi" | "quote" | "none";

/** Where the deal's owner came from. */
export type DealRepSource = "lead" | "bmi" | "planner" | "none";

export interface DealRep {
  id: string | null;
  slug: string;
  displayName: string;
  firstName: string;
  initials: string;
}

export interface Deal {
  /**
   * The row key, stable across reads: the project id when there is one, else
   * `q:<quoteId>` / `l:<leadId>`. React keys and selection use this; nothing
   * parses it.
   */
  key: string;
  spine: DealSpine;
  /** The BMI project id, or null for the handful of rows the mirror is missing. */
  projectId: string | null;
  project: DealProject | null;
  lead: DealLead | null;
  quote: DealQuote | null;

  // --- the merged view every lens renders -----------------------------------
  /** BMI first, then the quote, then the lead — the spine decides. */
  centre: CentreCode | null;
  centerCode: string | null;
  /** YYYY-MM-DD. BMI first: a rescheduled event moves in Office before the PDF. */
  eventDate: string | null;
  eventTime: string | null;
  title: string;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  guests: number | null;
  /** What the deal is worth, in cents: the contract total, else BMI's. */
  valueCents: number;
  /** Our sales status: the lead's, else the BMI state mapped, else null. */
  status: string | null;
  statusSource: DealStatusSource;
  rep: DealRep | null;
  repSource: DealRepSource;
  /** True when the guest has a contract — the Contracts lens. */
  hasQuote: boolean;
  /** True when a planner owns it in the CRM — false is a REAL answer, not a gap. */
  hasLead: boolean;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Which slice of the spine a lens needs. The projection is identical for all
 * three; only the key set differs, so a narrow lens stays a narrow query.
 *
 *   `quote`   one key per contract — the Contracts lens.
 *   `board`   group projects plus every lead — the Pipeline lens.
 *   `project` group projects only, by day — the Events lens.
 */
export type DealScope = "quote" | "board" | "project";

export interface DealFilter {
  scope: DealScope;
  /** YYYY-MM-DD inclusive, on the deal's event date. */
  from?: string;
  until?: string;
  centre?: CentreCode;
  /** A `crm_reps` slug. Matches the lead's rep, BMI's responsible or the planner. */
  repSlug?: string;
  q?: string;
  /** Only deals whose project is in one of these BMI states. */
  projectIds?: readonly string[];
  limit?: number;
}

export const DEAL_PAGE_MAX = 200;
