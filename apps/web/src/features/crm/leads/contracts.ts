/**
 * The leads sub's WIRE SHAPES — what `/api/admin/crm/leads/**` answers and the
 * queue / My Day / deal screens render.
 *
 * Kept here rather than appended to `core/contracts.ts` so the Wave-B PRs that
 * build in parallel do not all append to the end of one shared file (the
 * brief's "append-only" rule for `core/types.ts` is honoured: nothing there
 * changes; `CrmLead` is EXTENDED below with the fields B3 adds — `kids` and
 * the joined guest / rep columns — instead of edited).
 *
 * CLIENT-SAFE: type-only imports from core, no Node, no Neon. Ids are strings.
 */

import type { ApiOk, PublicRep } from "../core/contracts";
import type {
  CentreCode,
  CrmActivity,
  CrmLead,
  EventType,
  LeadSource,
  MintStatus,
  RuleTraceStep,
} from "../core/types";

// ---------------------------------------------------------------------------
// Labels (crm-data.js:58-59, verbatim)
// ---------------------------------------------------------------------------

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  corporate: "Corporate",
  birthday: "Birthday",
  team: "Team outing",
  school: "School / youth",
  fundraiser: "Fundraiser",
  holiday: "Holiday party",
};

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  web: "Web form",
  phone: "Phone",
  walkin: "Walk-in",
  cold: "Cold list",
  historical: "Last year",
  referral: "Referral",
};

/** Sources a member of staff may pick when logging a lead by hand. */
export const STAFF_LEAD_SOURCES: readonly LeadSource[] = ["phone", "walkin", "referral"];

// ---------------------------------------------------------------------------
// The lead as the client sees it
// ---------------------------------------------------------------------------

export interface LeadGuest {
  first: string;
  last: string;
  /** E.164 or null. */
  phone: string | null;
  email: string | null;
  /** The account name when the contact belongs to a business. */
  company: string | null;
  prefers: "text" | "call" | "email" | null;
}

/**
 * The planner the guest asked for on the public form (B7), joined from
 * `crm_reps` through `crm_leads.requested_rep_id`. It is carried whether or
 * not the rules honoured it — the queue card and the deal header read
 * "Guest asked for Kelsea" either way.
 */
export interface LeadRequestedRep {
  id: string;
  slug: string;
  firstName: string;
  displayName: string;
}

/**
 * `CrmLead` plus what every list and card needs without a second round trip:
 * the guest (joined from crm_contacts / crm_accounts), the assignee's slug and
 * name (joined from crm_reps), `kids` (B3's own column on crm_leads — the
 * flag that sends a birthday to Pandora as "Child Birthday", R2 in the rules)
 * and `requestedRep` (B7's column — who the guest asked for).
 */
export interface LeadView extends CrmLead {
  kids: boolean;
  guest: LeadGuest;
  repSlug: string | null;
  repName: string | null;
  requestedRep: LeadRequestedRep | null;
}

export type AssignmentReason = "manual" | "auto" | "reassign" | "rule" | "release";

/**
 * One `.tr-row` of a rule trace: the step plus the rule's label, and the
 * on-screen code ("R6") the pill shows. `ruleId` stays the DATABASE id — it is
 * what `crm_assignments.rule_id` stores and what the sheet matches the final
 * row on — so the code travels beside it rather than replacing it.
 */
export interface RuleTraceRowView extends RuleTraceStep {
  label: string;
  code?: string;
}

export interface LeadAssignmentView {
  id: string;
  leadId: string;
  fromRepId: string | null;
  toRepId: string | null;
  toRepName: string | null;
  toRepSlug: string | null;
  actorEmail: string;
  reason: AssignmentReason;
  ruleId: string | null;
  trace: RuleTraceRowView[];
  note: string | null;
  /** When the Office `responsible` PUT was verified; null = not (yet) synced. */
  bmiResponsibleSyncedAt: string | null;
  createdAt: string;
}

/** What the assignment engine proposes for an unassigned lead. */
export interface LeadSuggestionView {
  rep: PublicRep;
  reason: string;
  ruleId: string | null;
  /** "R6" — the deciding rule's on-screen code, for the trace's `.final` row. */
  finalRuleCode?: string | null;
}

// ---------------------------------------------------------------------------
// Outcomes of the two BMI-facing steps
// ---------------------------------------------------------------------------

export interface MintOutcomeView {
  status: MintStatus;
  /** `needs_email_or_time`, a Pandora message, or null. */
  error: string | null;
  projectId: string | null;
  projectNumber: string | null;
}

export type BmiResponsibleSyncStatus =
  | "synced"
  | "failed"
  | "paused"
  | "no_project"
  | "no_bmi_user"
  | "skipped";

export interface BmiResponsibleSyncOutcome {
  status: BmiResponsibleSyncStatus;
  error?: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /leads?… */
export type LeadsListResponse = ApiOk<{ leads: LeadView[]; nextCursor: string | null }>;

/** POST /leads (staff capture) */
export type LeadCreateResponse = ApiOk<{
  lead: LeadView;
  /** false when the row was a same-guest same-date duplicate within 15 min. */
  created: boolean;
  mint: MintOutcomeView;
  assignment: LeadAssignmentView | null;
}>;

/** GET /leads/[id] */
export type LeadDetailResponse = ApiOk<{
  lead: LeadView;
  activities: CrmActivity[];
  assignments: LeadAssignmentView[];
  reps: PublicRep[];
}>;

/** PATCH /leads/[id] */
export type LeadPatchResponse = ApiOk<{ lead: LeadView }>;

/** POST /leads/[id]/assign */
export type LeadAssignResponse = ApiOk<{
  lead: LeadView;
  assignment: LeadAssignmentView;
  bmi: BmiResponsibleSyncOutcome;
}>;

/** POST /leads/[id]/mint */
export type LeadMintResponse = ApiOk<{ lead: LeadView; mint: MintOutcomeView }>;

/** POST /leads/[id]/archive */
export type LeadArchiveResponse = ApiOk<{ lead: LeadView }>;

/** GET /leads/badges — the sidebar / bottom-tab counts. */
export type LeadBadgesResponse = ApiOk<{ overdue: number; unassigned: number }>;

export interface VolumeCell {
  guests: number;
  count: number;
}

/**
 * Why a lead is still on the queue board. The rules assign at capture, so
 * every lead here was parked: `held` by a hold rule, `no-rep` because the
 * engine named nobody, `retry` because the capture-time assign did not happen
 * and the safety-net sweep still owes it one.
 */
export type QueueParkKind = "held" | "no-rep" | "retry";

export interface QueuePark {
  kind: QueueParkKind;
  /** The pill's words, ready to render. */
  label: string;
}

export interface QueueLead {
  lead: LeadView;
  /** Whole minutes since capture. */
  ageMinutes: number;
  suggestion: LeadSuggestionView | null;
  park: QueuePark;
  trace: RuleTraceRowView[];
}

export interface QueueRepColumn {
  rep: PublicRep;
  /** party month ("2026-10") → open volume */
  volume: Record<string, VolumeCell>;
  /** Assigned, not yet touched — the response-time strip. */
  assigned: LeadView[];
}

/** GET /leads/queue — director only. */
export type QueueResponse = ApiOk<{
  unassigned: QueueLead[];
  reps: QueueRepColumn[];
  /** The three party months the volume meters show. */
  months: string[];
  /** How long a lead that arrived unassigned waits before the safety net retries it. */
  sweepDelayMinutes: number;
}>;

export interface RepMyDay {
  kind: "rep";
  greeting: string;
  dateLabel: string;
  overdue: LeadView[];
  dueToday: LeadView[];
  newLeads: LeadView[];
}

export interface DirectorLane {
  rep: PublicRep;
  overdue: number;
  /** The next five due items, soonest first (prototype `d.slice(0, 5)`). */
  due: LeadView[];
}

export interface DirectorMyDay {
  kind: "director";
  greeting: string;
  dateLabel: string;
  tiles: { unassigned: number; overdueTeam: number; contractsOut: number };
  lanes: DirectorLane[];
}

/** GET /leads/my-day */
export type MyDayResponse = ApiOk<{ view: RepMyDay | DirectorMyDay }>;

// ---------------------------------------------------------------------------
// DOM test ids for the three screens
// ---------------------------------------------------------------------------

export const LEAD_TEST_IDS = {
  queue: "crm-queue",
  queueUnassigned: "crm-queue-unassigned",
  queueRep: (slug: string) => "crm-queue-rep-" + slug,
  queueDragGhost: "crm-queue-drag-ghost",
  assignSheet: "crm-assign-sheet",
  newLeadSheet: "crm-new-lead-sheet",
  myDay: "crm-my-day",
  myDayColumn: (id: "overdue" | "due" | "new") => "crm-my-day-" + id,
  /** The two prototype blocks that ship empty and labelled until their PR lands. */
  myDayTargets: "crm-my-day-targets",
  myDayLastYear: "crm-my-day-last-year",
  directorBookedVsLy: "crm-director-booked-vs-ly",
  directorLane: (slug: string) => "crm-lane-" + slug,
  deal: "crm-deal",
  dealHeader: "crm-deal-header",
  dealTab: (id: string) => "crm-deal-tab-" + id,
  dealTabs: "crm-deal-tabs",
  leadCard: (publicId: string) => "crm-lead-" + publicId,
} as const;

/** `mint_error` when Pandora cannot accept the lead yet (policy (d)) — client-safe here, used by `service/mint.ts`. */
export const NEEDS_EMAIL_OR_TIME = "needs_email_or_time";

/** Centre → the Pandora `location` key `submitPartyLead` resolves. */
export const CENTRE_TO_PANDORA_KEY: Record<CentreCode, "headpinz" | "fasttrax" | "naples"> = {
  HPFM: "headpinz",
  FT: "fasttrax",
  HPN: "naples",
};
