/**
 * "Who would you like to work with?" — the guest's planner request as an
 * explicit STEP of the assignment decision (owner, 2026-09-13 14:05).
 *
 * PRECEDENCE, approved by the owner — do not re-litigate:
 *   the request BEATS the ordinary balancing rule (R6, lowest open volume for
 *   the party month) — ask for Kelsea, get Kelsea — and it does NOT beat the
 *   rules that exist for business reasons:
 *     R1  hold      ≥ 100 guests → the Marketing Director
 *     R2/R3 route   kids' birthdays and small school groups → Guest Services
 *     R4  avail     a planner who is off that day is skipped, so the lead is
 *                   worked today rather than sitting until they are back
 *   A children's party is ignored outright: Pandora force-routes
 *   `eventType: "Child Birthday"` to Guest Services whatever `agent` we send
 *   (brief §1.6), so honouring it would be a promise we cannot keep.
 *
 * WHENEVER THE REQUEST IS NOT HONOURED THE LEAD STILL CARRIES IT: the verdict
 * names the rule that won, the queue card and the deal header read
 * "Guest asked for Kelsea", and the trace note says so in words.
 *
 * WHERE THIS RUNS. It is a step of the decision, never a special case at the
 * call site: `leads/service/suggest.ts` — the ONE seam between the leads sub
 * and this one — applies it to whatever the engine decided, so `createLead`,
 * the mint policy and the queue all read one answer. When B2's
 * `assignDecision(lead, ctx)` is wired behind that seam, its `EngineDecision`
 * is exactly the `decision` argument below (`rep` / `reason` / `outcome` /
 * `finalRuleId`, structurally typed here so this module stays pure and
 * free of an import into the engine).
 *
 * PURE: no Neon, no clock of its own, no `Date.now()`.
 */

import type { CentreCode } from "~/features/crm/core/types";

/** What the rest of the decision concluded — B2's `DecisionOutcome`. */
export type DecisionOutcomeLike = "hold" | "route" | "assign" | "queue" | "none";

/** The rep fields this step needs; `CrmRep` and `PublicRep` both satisfy it. */
export interface RequestedRepLike {
  id: string;
  slug: string;
  firstName: string;
  displayName: string;
  centres: CentreCode[];
  active?: boolean;
  role?: string;
}

/** The decision reached by the rules BEFORE the guest's request is weighed. */
export interface DecisionLike<R extends RequestedRepLike = RequestedRepLike> {
  rep: R | null;
  reason: string;
  outcome: DecisionOutcomeLike;
  finalRuleId?: string | null;
}

export type RequestedRepOutcome =
  /** The guest did not ask for anyone. */
  | "none"
  /** A children's party — Pandora routes it to Guest Services regardless. */
  | "ignored"
  /** The name does not match a planner who sells at that centre any more. */
  | "unknown"
  /** R4: they are off that day. */
  | "unavailable"
  /** R1 hold / R2-R3 route won. */
  | "overridden"
  /** The rules have not run for this lead yet — carried, not yet acted on. */
  | "pending"
  /** Honoured, ahead of the balancing rule. */
  | "honoured";

export interface RequestedRepVerdict<R extends RequestedRepLike = RequestedRepLike> {
  outcome: RequestedRepOutcome;
  honoured: boolean;
  /** Who the lead should go to: the requested planner when honoured, else the rules' own pick. */
  rep: R | null;
  /** The one-line reason an assignment row records. */
  reason: string;
  /** The trace note — plain words for the queue card's "why". */
  note: string;
  /** The rule that beat the request, when one did. */
  overriddenBy: string | null;
}

export interface RequestedRepInput<R extends RequestedRepLike = RequestedRepLike> {
  /** The planner the guest asked for, resolved from the roster; null = none asked. */
  requested: R | null;
  /** The lead's centre — a Naples enquiry may not request a Fort Myers planner. */
  centre: CentreCode;
  /**
   * The event maps to Pandora's "Child Birthday". The CALLER decides this with
   * `pandoraEventTypeFor` so there is one source of truth for the mapping.
   */
  kidsBirthday: boolean;
  /** What the rules decided; null = they have not run for this lead. */
  decision: DecisionLike<R> | null;
  /** R4: the requested planner is off on the day the lead is being worked. */
  offToday?: boolean;
}

/** The id the trace row carries for this step — it is a step, not a stored rule. */
export const REQUESTED_REP_STEP_ID = "guest-request";
export const REQUESTED_REP_STEP_LABEL = "Guest's choice of planner";

/** Does this planner sell at that centre, and are they still on the roster? */
export function sellsAt(rep: RequestedRepLike, centre: CentreCode): boolean {
  if (rep.active === false) return false;
  if (rep.role != null && rep.role !== "rep") return false;
  return rep.centres.includes(centre);
}

function decided<R extends RequestedRepLike>(
  d: DecisionLike<R> | null,
): {
  rep: R | null;
  reason: string;
} {
  return { rep: d?.rep ?? null, reason: d?.reason ?? "" };
}

/**
 * Weigh the guest's request against what the rules decided.
 *
 * The answer is a verdict, not a mutation: the caller assigns `verdict.rep`
 * and records `verdict.note` on the trace whatever the outcome.
 */
export function requestedRepVerdict<R extends RequestedRepLike>(
  input: RequestedRepInput<R>,
): RequestedRepVerdict<R> {
  const base = decided(input.decision);
  const requested = input.requested;

  if (!requested) {
    return {
      outcome: "none",
      honoured: false,
      rep: base.rep,
      reason: base.reason,
      note: "",
      overriddenBy: null,
    };
  }

  const asked = `Guest asked for ${requested.firstName}`;

  if (input.kidsBirthday) {
    return {
      outcome: "ignored",
      honoured: false,
      rep: base.rep,
      reason: base.reason,
      note: `${asked} — children's parties go to Guest Services, so the request is not applied`,
      overriddenBy: null,
    };
  }

  if (!sellsAt(requested, input.centre)) {
    return {
      outcome: "unknown",
      honoured: false,
      rep: base.rep,
      reason: base.reason,
      note: `${asked} — they do not take ${input.centre} events, so the rules decided instead`,
      overriddenBy: null,
    };
  }

  if (!input.decision) {
    return {
      outcome: "pending",
      honoured: false,
      rep: null,
      reason: "",
      note: `${asked} — waiting for the rules to run`,
      overriddenBy: null,
    };
  }

  const d = input.decision;

  if (d.outcome === "hold" || d.outcome === "route") {
    const who = d.rep ? d.rep.displayName : "the rule's own destination";
    return {
      outcome: "overridden",
      honoured: false,
      rep: base.rep,
      reason: base.reason,
      note: `${asked} — ${d.reason || `this one goes to ${who}`} takes precedence`,
      overriddenBy: d.finalRuleId ?? null,
    };
  }

  if (input.offToday === true) {
    return {
      outcome: "unavailable",
      honoured: false,
      rep: base.rep,
      reason: base.reason,
      note: `${asked} — they are off today, so the lead is worked by ${
        base.rep ? base.rep.firstName : "whoever the rules pick"
      }`,
      overriddenBy: d.finalRuleId ?? null,
    };
  }

  return {
    outcome: "honoured",
    honoured: true,
    rep: requested,
    reason: `guest asked for ${requested.firstName}`,
    note:
      base.rep && base.rep.id !== requested.id
        ? `${asked} — honoured, ahead of ${base.reason || "the balancing rule"}`
        : `${asked} — honoured`,
    overriddenBy: null,
  };
}
