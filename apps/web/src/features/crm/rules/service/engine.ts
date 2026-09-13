/**
 * The assignment engine — a PURE function of `(lead, ctx)` (brief §3.10, B2).
 *
 * Ported line for line from the prototype's `assignDecision`
 * (`crm-shared.js:176-196`) over the rule data in `crm-data.js:33-41`, onto the
 * `AssignmentRule` / `AssignDecision` types in `core/types.ts`. Trace notes are
 * the prototype's strings verbatim; the Rules screen's "Try a lead" and the
 * queue's "Why Kelsea" render them unchanged.
 *
 *   candidates = active reps with role 'rep' whose `centres` include the lead's
 *   rules, enabled, by position:
 *     hold/route   when-clause hit → decide (rep resolved from the SLUG in then)
 *     avail.skipOff  drop candidates marked off today
 *     avail.onShift  exactly one on shift → decide; several → narrow; none →
 *                    narrow to whoever starts soonest (same-day set)
 *     standard     lowest Σ guests of OPEN leads for the party month, tie →
 *                  fewest leads → decide
 *     fallback     queue (rep null, "waits for Jacob")
 *   nothing matched → rep null, "no rule matched"
 *
 * `ctx.now` is an explicit instant; hours are ET through `availability.ts`
 * (the runner is UTC in CI — never `new Date().getHours()` here).
 *
 * Two deliberate extensions over the prototype, both inert on the seeded data:
 *   - `when.centre` / `when.source` / `when.partyMonth` (fields the prototype's
 *     rule sheet offers but its engine ignores) are honoured in the hit test;
 *   - `when.kids` matches a birthday unless the lead says `kids: false`, so B3
 *     can keep adult birthdays away from Guest Services without a new rule kind.
 *   And one correction: the skip-off note names the candidates actually
 *   removed, not every off rep on the roster.
 */

import { monthKey } from "~/features/crm/core/dates";
import type { DecisionOutcome } from "../contracts";
import type {
  AssignDecision,
  AssignmentRule,
  CentreCode,
  CrmRep,
  EventType,
  LeadSource,
  RuleTraceStep,
} from "~/features/crm/core/types";
import {
  fmtHour,
  isOffToday,
  nextStart,
  onShiftNow,
  type RosterByRep,
  type RosterClock,
} from "./availability";

/** What the engine needs to know about a lead — a real row or a hypothetical one. */
export interface EngineLead {
  centre: CentreCode;
  guests: number;
  type: EventType;
  /** YYYY-MM-DD — the party month the standard rule balances on. */
  eventDate: string;
  source?: LeadSource;
  /** A birthday for children; undefined = unknown (matches `when.kids` like the prototype). */
  kids?: boolean;
}

export interface VolumeCell {
  guests: number;
  count: number;
}

/** repId → "YYYY-MM" → Σ guests / count of OPEN leads assigned to that rep. */
export type VolumeByRepMonth = Record<string, Record<string, VolumeCell> | undefined>;

export interface EngineContext extends RosterClock {
  reps: readonly CrmRep[];
  rules: readonly AssignmentRule[];
  shiftsToday: RosterByRep;
  shiftsTomorrow: RosterByRep;
  openVolumeByRepMonth: VolumeByRepMonth;
  now: Date;
}

/** Defined in `../contracts` (client-safe); re-exported here where the engine uses it. */
export type { DecisionOutcome };

/** `AssignDecision` plus what kind of answer it is (the sweep and B3's assign read it). */
export interface EngineDecision extends AssignDecision {
  outcome: DecisionOutcome;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(ymd: string): string {
  return MON[Number(monthKey(ymd).slice(5)) - 1] ?? monthKey(ymd);
}

export function volumeFor(
  ctx: Pick<EngineContext, "openVolumeByRepMonth">,
  repId: string,
  month: string,
): VolumeCell {
  return ctx.openVolumeByRepMonth[repId]?.[month] ?? { guests: 0, count: 0 };
}

/** Active people (not buckets/holds/directors) who sell at the lead's centre. */
export function candidateReps(reps: readonly CrmRep[], centre: CentreCode): CrmRep[] {
  return reps.filter((r) => r.active && r.role === "rep" && r.centres.includes(centre));
}

/** The prototype's `standardPick`: lowest guests, then fewest leads; stable beyond that. */
export function standardPick(
  cands: readonly CrmRep[],
  lead: EngineLead,
  ctx: Pick<EngineContext, "openVolumeByRepMonth">,
): CrmRep | undefined {
  const m = monthKey(lead.eventDate);
  return [...cands].sort((a, b) => {
    const va = volumeFor(ctx, a.id, m);
    const vb = volumeFor(ctx, b.id, m);
    return va.guests - vb.guests || va.count - vb.count;
  })[0];
}

/** The hold/route when-clause (`crm-shared.js:181`, plus the three extra fields). */
export function whenMatches(rule: AssignmentRule, lead: EngineLead): boolean {
  const w = rule.when;
  return (
    (w.guestsMin == null || lead.guests >= w.guestsMin) &&
    (w.guestsMax == null || lead.guests <= w.guestsMax) &&
    (!w.type || lead.type === w.type) &&
    (!w.kids || (lead.type === "birthday" && lead.kids !== false)) &&
    (!w.centre || lead.centre === w.centre) &&
    (!w.source || lead.source === w.source) &&
    (!w.partyMonth || monthKey(lead.eventDate) === w.partyMonth)
  );
}

/** Rules the engine runs: enabled, in position order. */
export function activeRules(rules: readonly AssignmentRule[]): AssignmentRule[] {
  return rules.filter((r) => r.enabled).sort((a, b) => a.position - b.position);
}

/** "today 9" sorts before "tomorrow 9": the prototype's `(when === "today" ? 0 : 24) + h`. */
function absoluteHour(n: { when: "today" | "tomorrow"; hour: number }): number {
  return (n.when === "today" ? 0 : 24) + n.hour;
}

export function assignDecision(lead: EngineLead, ctx: EngineContext): EngineDecision {
  const trace: RuleTraceStep[] = [];
  let cands = candidateReps(ctx.reps, lead.centre);
  const repBySlug = (slug: string | undefined) =>
    slug ? (ctx.reps.find((r) => r.slug === slug && r.active) ?? null) : null;

  for (const r of activeRules(ctx.rules)) {
    if (r.kind === "hold" || r.kind === "route") {
      const hit = whenMatches(r, lead);
      if (!hit) {
        trace.push({ ruleId: r.id, hit: false });
        continue;
      }
      const slug = r.kind === "hold" ? r.then.hold : r.then.route;
      const rep = repBySlug(slug);
      if (!rep) {
        // A rule that names nobody on the roster cannot decide; say so and move on.
        trace.push({ ruleId: r.id, hit: true, note: `no rep '${slug ?? "?"}' on the roster` });
        continue;
      }
      trace.push({ ruleId: r.id, hit: true });
      return {
        rep,
        reason: r.kind === "hold" ? `held for ${rep.displayName}` : `routed to ${rep.displayName}`,
        trace,
        finalRuleId: r.id,
        outcome: r.kind,
      };
    }

    if (r.kind === "avail" && r.then.skipOff) {
      const before = cands;
      cands = cands.filter((c) => !isOffToday(c.id, ctx));
      const skipped = before.filter((c) => !cands.includes(c));
      trace.push({
        ruleId: r.id,
        hit: skipped.length > 0,
        note: skipped.length
          ? `skipped ${skipped.map((x) => x.firstName).join(", ")} (off today)`
          : "nobody is off",
      });
      continue;
    }

    if (r.kind === "avail" && r.then.onShift) {
      const now = cands.filter((c) => onShiftNow(c.id, ctx));
      if (now.length === 1) {
        const rep = now[0];
        trace.push({
          ruleId: r.id,
          hit: true,
          note: `${rep.firstName} is the only one on shift now`,
        });
        return { rep, reason: "on shift now", trace, finalRuleId: r.id, outcome: "assign" };
      }
      if (now.length > 1) {
        cands = now;
        trace.push({
          ruleId: r.id,
          hit: true,
          note: `${now.map((x) => x.firstName).join(" and ")} are on shift now → standard rule picks between them`,
        });
        continue;
      }
      const nexts = cands
        .map((c) => ({ c, n: nextStart(c.id, ctx) }))
        .filter((x): x is { c: CrmRep; n: NonNullable<typeof x.n> } => x.n !== null);
      if (nexts.length) {
        const soonest = Math.min(...nexts.map((x) => absoluteHour(x.n)));
        const soonestWhen = nexts.find((y) => absoluteHour(y.n) === soonest)!.n.when;
        const sameDay = nexts.filter((x) => x.n.when === soonestWhen);
        cands = sameDay.map((x) => x.c);
        trace.push({
          ruleId: r.id,
          hit: true,
          note: `nobody on shift now · next in: ${sameDay
            .map((x) => `${x.c.firstName} ${fmtHour(x.n.hour)} ${x.n.when}`)
            .join(", ")} → standard rule picks between them`,
        });
      } else {
        trace.push({ ruleId: r.id, hit: false, note: "no upcoming shifts on file" });
      }
      continue;
    }

    if (r.kind === "standard") {
      if (cands.length) {
        const rep = standardPick(cands, lead, ctx)!;
        const v = volumeFor(ctx, rep.id, monthKey(lead.eventDate));
        const mon = monthLabel(lead.eventDate);
        trace.push({
          ruleId: r.id,
          hit: true,
          note: `${rep.firstName} has the lowest ${mon} volume (${v.guests} guests in ${v.count} leads)`,
        });
        return {
          rep,
          reason: `lowest ${mon} volume`,
          trace,
          finalRuleId: r.id,
          outcome: "assign",
        };
      }
      trace.push({ ruleId: r.id, hit: false, note: "no eligible rep" });
      continue;
    }

    if (r.kind === "fallback") {
      trace.push({ ruleId: r.id, hit: true });
      return { rep: null, reason: "waits for Jacob", trace, finalRuleId: r.id, outcome: "queue" };
    }

    // An avail rule with neither flag, or an unknown kind: recorded, never decisive.
    trace.push({ ruleId: r.id, hit: false, note: "did not apply" });
  }
  return { rep: null, reason: "no rule matched", trace, outcome: "none" };
}

/** The prototype's `autoPick`: the decision's rep, else the Guest Services bucket. */
export function autoPick(lead: EngineLead, ctx: EngineContext): CrmRep | null {
  return assignDecision(lead, ctx).rep ?? ctx.reps.find((r) => r.slug === "gs") ?? null;
}
