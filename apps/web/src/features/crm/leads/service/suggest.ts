/**
 * `suggestFor(lead)` — the ONE seam between the leads sub and the assignment
 * engine (B2's `~/features/crm/rules`, built in parallel).
 *
 * TODAY IT PROPOSES NOTHING: `{ suggestion: null, trace: [] }` for every lead.
 * A follow-up stage points this function at `assignDecision(lead, ctx)` once
 * B2 lands; the queue API, the AssignSheet ("No auto-pick yet"), `createLead`
 * (agent "First Available" when there is no pick) and the mint policy all read
 * their answer from here and nowhere else, so that swap is one file.
 *
 * `~/features/crm/rules` is deliberately NOT imported (B3 coordination note).
 */

import type { CrmRep } from "../../core/types";
import type { LeadView, RuleTraceRowView } from "../contracts";

export interface LeadSuggestion {
  rep: CrmRep;
  /** "lowest Oct volume", "routed to Guest Services", … */
  reason: string;
  /** `crm_assignment_rules.id` (numeric text) when a stored rule decided; null otherwise. */
  ruleId: string | null;
  /** The seed label ("R6") of the deciding rule, for the `.final` row. */
  finalRuleLabel: string | null;
}

export interface SuggestContext {
  now?: Date;
  reps?: readonly CrmRep[];
}

export interface SuggestResult {
  suggestion: LeadSuggestion | null;
  trace: RuleTraceRowView[];
}

/** What the queue shows while the engine is not wired: nothing picked, nothing traced. */
export const NO_SUGGESTION: SuggestResult = Object.freeze({ suggestion: null, trace: [] });

export async function suggestFor(lead: LeadView, ctx: SuggestContext = {}): Promise<SuggestResult> {
  void lead;
  void ctx;
  return { suggestion: null, trace: [] };
}
