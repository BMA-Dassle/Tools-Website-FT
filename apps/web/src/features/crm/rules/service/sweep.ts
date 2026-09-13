/**
 * The assign sweep (brief §3.9 `assign-sweep:<hour>`): the rail that takes the
 * leads the queue has been holding and hands them to a rep once the director's
 * delay has passed. B2 built the deciding half; this is both halves.
 *
 * DECIDE: find open, unassigned, unheld leads older than the director's delay
 * setting (`crm_settings.sweep.delayMinutes`, default 60) and run every one
 * through `assignDecision`.
 *
 * APPLY: hand each decision that resolved a rep to B3's `assignLead` with
 * `reason: "auto"`, the deciding rule's id and its trace — the same rail a
 * director's manual assign uses, so the Neon row, `crm_assignments`, the
 * activity, the first-touch `next_action` and the Office `responsible` PUT all
 * happen exactly once and in that order. The leads sub is imported DYNAMICALLY
 * (the same trick `data/volume-db.ts` uses): a static edge would close a cycle
 * between two eager re-export barrels (§3.2).
 *
 * Every lead the sweep does NOT assign is logged with its reason — no rep
 * resolved (the fallback rule parks it for Jacob), the lead moved between the
 * candidate query and the apply, or `assignLead` threw. The sweep never
 * retries inside one run; the next hour's sweep sees the same lead again.
 *
 * Kill switch `CRM_AUTO_ASSIGN !== "false"` (R4) is checked HERE as well as in
 * the job handler, so no caller of `runAssignSweep` can write past it.
 *
 * After-hours (`sweep.afterHours`): `hold9am` computes the decisions but marks
 * the run `held` outside business hours — the prototype's "Hold until 9 AM";
 * `assign` runs regardless. Business hours are 9 AM–9 PM ET
 * (`SWEEP_BUSINESS_HOURS`) — an assumption until D1/D14 close; the setting
 * itself is the owner's knob.
 *
 * Idempotency: one row per ET hour (`assign-sweep:2026-09-12T19`), so a cron
 * that fires every two minutes still sweeps once an hour.
 */

import { etHourOfDay, todayEasternYmd } from "~/features/crm/core/dates";
import { crmAutoAssignEnabled } from "~/features/crm/core/flags";
import { publicRep } from "~/features/crm/core/projections";
import type { SweepSetting } from "~/features/crm/core/types";
import type { SweepDecision, SweepResult, TraceRowWire } from "../contracts";
import type { SweepCandidate } from "../data/volume-db";
import { assignDecision, type EngineContext } from "./engine";
import { toDecisionWire } from "./wire";

export type { SweepDecision, SweepResult };

export const SWEEP_BUSINESS_HOURS = { start: 9, end: 21 } as const;
/** Nothing was handed over: no candidates, or no decision resolved a rep. */
export const SWEEP_NOT_APPLIED_REASON = "nothing to apply";
export const SWEEP_HELD_REASON = "outside business hours · held until 9 AM";
export const SWEEP_DISABLED_REASON = 'CRM_AUTO_ASSIGN="false"';
export const SWEEP_APPLIED_REASON = "applied";
/** `crm_assignments.actor_email` for a hand-off the sweep made on nobody's behalf. */
export const SWEEP_ACTOR = "assign-sweep";

/** leadId → the trace rows (label + "R6" code resolved) behind its decision. */
export type SweepTraces = ReadonlyMap<string, TraceRowWire[]>;

/** `assign-sweep:<ET date>T<HH>` — one sweep per ET hour. */
export function sweepIdempotencyKey(now: Date): string {
  const hh = String(Math.floor(etHourOfDay(now))).padStart(2, "0");
  return `assign-sweep:${todayEasternYmd(now)}T${hh}`;
}

/** `sevenshifts-mirror:<ET date>` — one mirror row per ET day. */
export function mirrorIdempotencyKey(now: Date): string {
  return `sevenshifts-mirror:${todayEasternYmd(now)}`;
}

export function isAfterHours(now: Date): boolean {
  const h = etHourOfDay(now);
  return h < SWEEP_BUSINESS_HOURS.start || h >= SWEEP_BUSINESS_HOURS.end;
}

export interface SweepDeps {
  now: Date;
  settings: SweepSetting;
  listCandidates(olderThan: Date, limit: number): Promise<SweepCandidate[]>;
  loadContext(now: Date): Promise<EngineContext>;
  /** Defaults to the live rail (`applySweepDecisions` → B3's `assignLead`). */
  applyDecisions?: (decisions: SweepDecision[], traces?: SweepTraces) => Promise<number>;
  /** Defaults to the `CRM_AUTO_ASSIGN` kill switch; injected by its test. */
  autoAssignEnabled?: () => boolean;
}

/**
 * The live rail: one `assignLead` per decision that resolved a rep, with the
 * rule's id and trace so the deal's history says WHY. Skips are logged, never
 * thrown — one lead that has moved on must not stop the rest of the sweep.
 */
export async function applySweepDecisions(
  decisions: readonly SweepDecision[],
  traces?: SweepTraces,
  actor: string = SWEEP_ACTOR,
): Promise<number> {
  const pickable = decisions.filter((d) => d.rep !== null);
  for (const d of decisions) {
    if (!d.rep) {
      console.log("[crm] assign-sweep skipped a lead", {
        lead_id: d.leadId,
        public_id: d.publicId,
        outcome: d.outcome,
        why: d.reason,
      });
    }
  }
  if (pickable.length === 0) return 0;

  const { assignLead } = await import("~/features/crm/leads");
  let applied = 0;
  for (const d of pickable) {
    try {
      await assignLead({
        leadId: d.leadId,
        repId: d.rep!.id,
        actor,
        reason: "auto",
        ruleId: d.finalRuleId,
        trace: traces?.get(d.leadId) ?? null,
        note: d.reason,
      });
      applied++;
    } catch (err) {
      console.error("[crm] assign-sweep could not hand a lead over", {
        lead_id: d.leadId,
        public_id: d.publicId,
        rep_id: d.rep!.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return applied;
}

export async function runAssignSweep(deps: SweepDeps): Promise<SweepResult> {
  const olderThan = new Date(deps.now.getTime() - deps.settings.delayMinutes * 60_000);
  const candidates = await deps.listCandidates(olderThan, 200);
  const held = deps.settings.afterHours === "hold9am" && isAfterHours(deps.now);

  const decisions: SweepDecision[] = [];
  const traces = new Map<string, TraceRowWire[]>();
  if (candidates.length > 0) {
    const ctx = await deps.loadContext(deps.now);
    for (const c of candidates) {
      const d = assignDecision(
        {
          centre: c.centre,
          guests: c.guests,
          type: c.type,
          eventDate: c.eventDate,
          source: c.source,
          kids: c.kids,
        },
        ctx,
      );
      traces.set(c.id, toDecisionWire(d, ctx.rules).trace);
      decisions.push({
        leadId: c.id,
        publicId: c.publicId,
        centre: c.centre,
        guests: c.guests,
        type: c.type,
        eventDate: c.eventDate,
        source: c.source,
        ageMinutes: Math.max(
          0,
          Math.floor((deps.now.getTime() - new Date(c.createdAt).getTime()) / 60_000),
        ),
        rep: publicRep(d.rep),
        outcome: d.outcome,
        reason: d.reason,
        finalRuleId: d.finalRuleId ?? null,
      });
    }
  }

  let applied = 0;
  let reason = SWEEP_NOT_APPLIED_REASON;
  if (held) {
    reason = SWEEP_HELD_REASON;
  } else if (decisions.length > 0) {
    const autoOn = (deps.autoAssignEnabled ?? crmAutoAssignEnabled)();
    if (!autoOn) {
      reason = SWEEP_DISABLED_REASON;
    } else {
      applied = await (deps.applyDecisions ?? applySweepDecisions)(decisions, traces);
      if (applied > 0) reason = SWEEP_APPLIED_REASON;
    }
  }

  return {
    ranAt: deps.now.toISOString(),
    delayMinutes: deps.settings.delayMinutes,
    afterHours: deps.settings.afterHours,
    held,
    candidates: candidates.length,
    decisions,
    applied,
    reason,
  };
}
