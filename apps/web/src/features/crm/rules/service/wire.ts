/**
 * Server-side shaping for the rules routes: engine output → `DecisionWire`,
 * the roster → `RosterRowWire[]`, and the two ET labels the prototype prints
 * ("Sat Sep 12", "7:30 PM on a Saturday"). Pure apart from `Intl`.
 */

import { ET } from "~/features/crm/core/dates";
import { etHourOfDay } from "~/features/crm/core/dates";
import { publicRep } from "~/features/crm/core/projections";
import type { AssignmentRule, CrmRep } from "~/features/crm/core/types";
import type { DecisionWire, RosterRowWire, ShiftWindowWire, TraceRowWire } from "../contracts";
import {
  fmtHour,
  fmtWindow,
  rosterReps,
  rosterStatus,
  type RosterClock,
  type ShiftWindow,
} from "./availability";
import type { EngineDecision } from "./engine";
import { REQUESTED_REP_STEP_ID, REQUESTED_REP_STEP_LABEL } from "./requested-rep";

/**
 * Trace rows that are STEPS rather than stored rules (B7's guest request):
 * they have no `crm_assignment_rules` row, so the code and label come from
 * here instead of from the rule table.
 */
const STEP_CODES: Record<string, string> = { [REQUESTED_REP_STEP_ID]: "GUEST" };
const STEP_LABELS: Record<string, string> = { [REQUESTED_REP_STEP_ID]: REQUESTED_REP_STEP_LABEL };

/** The on-screen code for a rule: "R3" from its position. */
export function ruleCode(rule: Pick<AssignmentRule, "position">): string {
  return `R${rule.position}`;
}

export function toDecisionWire(
  decision: EngineDecision,
  rules: readonly AssignmentRule[],
): DecisionWire {
  const byId = new Map(rules.map((r) => [r.id, r] as const));
  const trace: TraceRowWire[] = decision.trace.map((t) => {
    const rule = byId.get(t.ruleId);
    return {
      ...t,
      code: rule ? ruleCode(rule) : (STEP_CODES[t.ruleId] ?? t.ruleId),
      label: rule?.label ?? STEP_LABELS[t.ruleId] ?? t.ruleId,
    };
  });
  const final = decision.finalRuleId ? byId.get(decision.finalRuleId) : undefined;
  return {
    rep: publicRep(decision.rep),
    reason: decision.reason,
    outcome: decision.outcome,
    trace,
    finalRuleId: decision.finalRuleId ?? null,
    finalRuleCode: final ? ruleCode(final) : null,
  };
}

function windowWire(w: ShiftWindow | null): ShiftWindowWire | null {
  return w ? { startHour: w.startHour, endHour: w.endHour, label: fmtWindow(w)! } : null;
}

/** One roster row per non-director rep, in roster order. */
export function toRosterRows(reps: readonly CrmRep[], clock: RosterClock): RosterRowWire[] {
  return rosterReps(reps).map((rep) => {
    const today = clock.shiftsToday[rep.id];
    const tomorrow = clock.shiftsTomorrow[rep.id];
    return {
      rep: publicRep(rep)!,
      today: windowWire(today?.window ?? null),
      tomorrow: windowWire(tomorrow?.window ?? null),
      offToday: today?.off === true,
      offReason: today?.off ? (today.offReason ?? null) : null,
      status: rosterStatus(rep.id, clock),
    };
  });
}

const F_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  weekday: "short",
  month: "short",
  day: "numeric",
});
const F_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "long" });

/** "Sat Sep 12" — the roster card's title date (`crm-shared.js:454`). */
export function rosterDateLabel(now: Date): string {
  return F_DAY.format(now).replace(",", "");
}

/** "7:30 PM on a Saturday" — rounded DOWN to the half hour like the prototype (`crm-shared.js:462`). */
export function nowLabel(now: Date): string {
  const h = Math.floor(etHourOfDay(now) * 2) / 2;
  return `${fmtHour(h)} on a ${F_WEEKDAY.format(now)}`;
}
