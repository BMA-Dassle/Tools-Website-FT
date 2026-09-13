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

export interface DecisionWire {
  rep: PublicRep | null;
  reason: string;
  outcome: "hold" | "route" | "assign" | "queue" | "none";
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
} as const;

/** The route families B2 adds under `/api/admin/crm`. */
export const RULES_ROUTES = ["/rules", "/roster"] as const;
