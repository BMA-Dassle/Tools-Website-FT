/**
 * The wire contract for the rules routes (B2), kept beside the sub rather than
 * appended to `core/contracts.ts` so parallel PRs never race on one file's
 * tail. Same rules as the core contract: dependency-free apart from types,
 * ids are strings, client components may import it.
 */

import type { ApiOk, PublicRep } from "~/features/crm/core/contracts";
import type {
  AssignmentRule,
  CentreCode,
  EventType,
  LeadSource,
  RuleKind,
  RuleThen,
  RuleWhen,
  RuleTraceStep,
} from "~/features/crm/core/types";

// ---------------------------------------------------------------------------
// GET / POST /api/admin/crm/rules
// ---------------------------------------------------------------------------

export type RulesResponse = ApiOk<{
  rules: AssignmentRule[];
  /** Everyone a rule may name (people, buckets, holds — not directors). */
  reps: PublicRep[];
}>;

export interface RuleInputWire {
  id?: string;
  label: string;
  kind: RuleKind;
  why?: string | null;
  when: RuleWhen;
  then: RuleThen;
  enabled?: boolean;
}

export type RulesPostBody =
  | { action: "upsert"; rule: RuleInputWire }
  | { action: "toggle"; id: string; enabled: boolean }
  | { action: "reorder"; ids: string[] };

export type RulesPostResponse = ApiOk<{ rules: AssignmentRule[] }>;

// ---------------------------------------------------------------------------
// GET /api/admin/crm/rules/try
// ---------------------------------------------------------------------------

export interface TryLeadQueryWire {
  guests: number;
  type: EventType;
  centre: CentreCode;
  eventDate?: string;
  kids?: boolean;
  source?: LeadSource;
}

/** One trace row with the rule's label and on-screen code ("R3") resolved. */
export interface TraceRowWire extends RuleTraceStep {
  code: string;
  label: string;
}

/**
 * What kind of answer the engine gave. Defined here — not in `service/engine.ts`
 * — so the sweep's wire shapes and the client components can name it without
 * reaching into a server module (§3.2); the engine re-exports it.
 */
export type DecisionOutcome = "hold" | "route" | "assign" | "queue" | "none";

export interface DecisionWire {
  rep: PublicRep | null;
  reason: string;
  outcome: DecisionOutcome;
  trace: TraceRowWire[];
  finalRuleId: string | null;
  finalRuleCode: string | null;
}

export type TryLeadResponse = ApiOk<{
  lead: Required<Pick<TryLeadQueryWire, "guests" | "type" | "centre" | "eventDate">> &
    Pick<TryLeadQueryWire, "kids" | "source">;
  decision: DecisionWire;
  /** The server's clock, ISO. */
  now: string;
  /** "7:30 PM on a Saturday" — the prototype's footer. */
  nowLabel: string;
}>;

// ---------------------------------------------------------------------------
// GET / POST /api/admin/crm/roster
// ---------------------------------------------------------------------------

export interface ShiftWindowWire {
  startHour: number;
  endHour: number;
  /** "10 AM – 6 PM" */
  label: string;
}

export interface RosterRowWire {
  rep: PublicRep;
  today: ShiftWindowWire | null;
  tomorrow: ShiftWindowWire | null;
  offToday: boolean;
  offReason: string | null;
  status: { kind: "off" | "on" | "next" | "none"; label: string };
}

export type RosterResponse = ApiOk<{
  /** ET business dates. */
  date: string;
  tomorrow: string;
  /** "Sat Sep 12" — the card title's date. */
  dateLabel: string;
  rows: RosterRowWire[];
  /** True once any 7shifts row exists for the two dates. */
  mirrored: boolean;
  lastSyncedAt: string | null;
  /** Whether the server holds a 7shifts token at all. */
  sevenShiftsConfigured: boolean;
  now: string;
}>;

export interface RosterPostBody {
  repId: string;
  date?: string;
  off: boolean;
  reason?: string;
}

export type RosterPostResponse = RosterResponse;

// ---------------------------------------------------------------------------
// The assign sweep's result (the shape `POST /jobs/run {kind:"assign-sweep"}`
// returns; `service/sweep.ts` produces it, the Sweep card renders it)
// ---------------------------------------------------------------------------

export interface SweepDecision {
  leadId: string;
  publicId: string;
  centre: CentreCode;
  guests: number;
  type: EventType;
  eventDate: string;
  source: LeadSource;
  ageMinutes: number;
  rep: PublicRep | null;
  outcome: DecisionOutcome;
  reason: string;
  finalRuleId: string | null;
}

export interface SweepResult {
  ranAt: string;
  /** How long a lead that arrived unassigned waits before the net retries it. */
  delayMinutes: number;
  candidates: number;
  decisions: SweepDecision[];
  applied: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Guest Services = a 7shifts DEPARTMENT (owner decision 2026-09-13, §5.7b)
// ---------------------------------------------------------------------------

/**
 * `crm_settings.sevenshifts`. A LIST of department ids so a second centre can
 * be added on the Rules screen without a migration; seeded with the single id
 * the owner named (`635186`, "Call Center", HeadPinz Fort Myers).
 */
export interface SevenShiftsSetting {
  gsDepartmentIds: number[];
  gsDepartmentName: string;
}

/**
 * One member of those departments as the Rules screen lists them.
 *
 * `worksAsGs` is NEVER derived from department membership — Eric and Jacob are
 * in the call-centre department and must keep their own rep rows — it is true
 * only when a `crm_rep_logins` row already points that address at the bucket.
 */
export interface GsMemberWire {
  sevenShiftsUserId: number;
  name: string;
  email: string | null;
  /** Which of the configured departments this user came back from. */
  departmentIds: number[];
  /** A `crm_rep_logins` row maps them to the Guest Services bucket. */
  worksAsGs: boolean;
  /** The director may tick them; false when `blockedReason` explains why not. */
  eligible: boolean;
  blockedReason: string | null;
  /** Not an @headpinz.com address — it can never sign in; flagged, never auto-added. */
  external: boolean;
  /** Their own rep row, when the address already belongs to one. */
  ownRep: { slug: string; displayName: string } | null;
}

export type GsResponse = ApiOk<{
  setting: SevenShiftsSetting;
  /** Whether the server holds a 7shifts token at all. */
  configured: boolean;
  /** The bucket row the shifts and the logins attach to. */
  gsRep: PublicRep | null;
  members: GsMemberWire[];
  /** 7shifts refused or is unreachable — the card says so instead of pretending. */
  membersError: string | null;
}>;

export type GsPostBody =
  | { action: "departments"; ids: number[]; name?: string }
  | { action: "login"; email: string; works: boolean };

export type GsPostResponse = GsResponse;

// ---------------------------------------------------------------------------
// DOM test ids for the Rules screen
// ---------------------------------------------------------------------------

export const RULES_TEST_IDS = {
  rulesList: "crm-rules-list",
  rule: (id: string) => "crm-rule-" + id,
  ruleToggle: (id: string) => "crm-rule-toggle-" + id,
  roster: "crm-roster",
  rosterEmpty: "crm-roster-empty",
  offToggle: (repId: string) => "crm-off-toggle-" + repId,
  tryLead: "crm-try-lead",
  tryVerdict: "crm-try-verdict",
  sweep: "crm-sweep",
  ruleSheet: "crm-rule-sheet",
  gs: "crm-gs-members",
  gsToggle: (userId: number) => "crm-gs-toggle-" + userId,
} as const;

/** The route families B2 adds under `/api/admin/crm`. */
export const RULES_ROUTES = ["/rules", "/rules/gs", "/roster"] as const;
