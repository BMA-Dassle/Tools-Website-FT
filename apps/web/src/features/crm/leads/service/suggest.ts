/**
 * `suggestFor(lead)` — the ONE seam between the leads sub and the assignment
 * engine (B2, `~/features/crm/rules`).
 *
 * It runs the real rules now: `loadEngineContext` assembles the roster, the
 * rule table, today's and tomorrow's shifts and the open volume per rep per
 * party month from Neon, `assignDecision` decides, and `toDecisionWire`
 * resolves each trace row's label and "R6" code. The queue API, the
 * AssignSheet's "Why Kelsea" trace, `createLead`'s capture-time assignment and
 * the mint's `agent` all read their answer from here and nowhere else.
 *
 * TWO THINGS IT NEVER DOES:
 *   - throw. A lead is captured whether or not the engine can answer (R2): a
 *     failure is logged and answered as `NO_SUGGESTION`, so the lead lands in
 *     the queue for a human instead of 500ing the guest's form.
 *   - load the context per lead when the caller already has one. The queue
 *     builds it ONCE and passes it in `ctx.engine`; without that, a 40-lead
 *     queue would be 40 × four round trips.
 *
 * The context is centre-agnostic by construction (the engine narrows
 * candidates by the lead's own centre — `service/context.ts`), so one load
 * serves a queue of leads from all three centres.
 */

import {
  assignDecision,
  loadEngineContext,
  toDecisionWire,
  type DecisionOutcome,
  type EngineContext,
  type EngineLead,
} from "~/features/crm/rules";
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
  /** Unused by the engine (it loads its own roster); kept for callers that have one. */
  reps?: readonly CrmRep[];
  /** A context already loaded by the caller — the queue loads one for the whole board. */
  engine?: EngineContext;
}

export interface SuggestResult {
  suggestion: LeadSuggestion | null;
  trace: RuleTraceRowView[];
  /** What kind of answer it was: hold · route · assign · queue · none. */
  outcome: DecisionOutcome;
}

/** What the queue shows when the engine could not answer: nothing picked, nothing traced. */
export const NO_SUGGESTION: SuggestResult = Object.freeze({
  suggestion: null,
  trace: [],
  outcome: "none" as DecisionOutcome,
});

/** The six fields the engine reads off a lead row. */
export function toEngineLead(lead: LeadView): EngineLead {
  return {
    centre: lead.centre,
    guests: lead.guests,
    type: lead.type,
    eventDate: lead.eventDate,
    source: lead.source,
    kids: lead.kids,
  };
}

/**
 * EVERY decision the engine resolves is applied at capture (owner,
 * 2026-09-13 14:50) — `hold` and `route`, which the rules make for a business
 * reason, and `assign`, the balancing rule's pick, which used to wait for the
 * sweep's delay so the director had the window the queue's countdown promised.
 * That window and that countdown are gone, so the only question left is
 * whether the engine named anybody: `outcome` "queue" and "none" resolve no
 * rep, and everything else does.
 *
 * There is therefore no `isImmediate` predicate any more. `createLead` gates
 * on `suggestion.suggestion`, and what KIND of decision it was decides how it
 * is recorded, not whether: a `hold` parks the lead (`assignLead` writes
 * `held_for_rep_id` and leaves `assigned_rep_id` NULL), `route` and `assign`
 * hand it over.
 */

export async function suggestFor(lead: LeadView, ctx: SuggestContext = {}): Promise<SuggestResult> {
  try {
    const engine = ctx.engine ?? (await loadEngineContext(lead.centre, ctx.now ?? new Date()));
    const decision = assignDecision(toEngineLead(lead), engine);
    const wire = toDecisionWire(decision, engine.rules);
    return {
      suggestion: decision.rep
        ? {
            rep: decision.rep,
            reason: decision.reason,
            ruleId: decision.finalRuleId ?? null,
            finalRuleLabel: wire.finalRuleCode,
          }
        : null,
      trace: wire.trace,
      outcome: decision.outcome,
    };
  } catch (err) {
    // The engine is advisory; a lead is never lost because the rules could not run.
    console.error("[crm] the assignment rules could not answer", {
      lead_id: lead.id,
      centre: lead.centre,
      error: err instanceof Error ? err.message : String(err),
    });
    return { suggestion: null, trace: [], outcome: "none" };
  }
}
