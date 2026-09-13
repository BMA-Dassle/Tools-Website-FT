/**
 * The assign sweep (brief §3.9 `assign-sweep:<hour>`, B2 "sweep only
 * enqueues; the assign itself calls `leads/service/assign.ts` from B3").
 *
 * B2 ships the DECIDING half: find open, unassigned, unheld leads older than
 * the director's delay setting (`crm_settings.sweep.delayMinutes`, default
 * 60), run every one through `assignDecision`, and return the decisions in the
 * job result with `applied: 0` and the reason `assign rail lands with B3`. A
 * follow-up stage wires B3's `assignLead` into `applyDecisions` once both are
 * on `feat/crm`; nothing in this file imports the leads sub beyond the read-only
 * candidate query in `data/volume-db.ts`.
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
import { publicRep } from "~/features/crm/core/projections";
import type { SweepSetting } from "~/features/crm/core/types";
import type { SweepDecision, SweepResult } from "../contracts";
import type { SweepCandidate } from "../data/volume-db";
import { assignDecision, type EngineContext } from "./engine";

export type { SweepDecision, SweepResult };

export const SWEEP_BUSINESS_HOURS = { start: 9, end: 21 } as const;
export const SWEEP_NOT_APPLIED_REASON = "assign rail lands with B3";
export const SWEEP_HELD_REASON = "outside business hours · held until 9 AM";

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
  /** B3 wires the assign rail here; B2 has none, so decisions are reported only. */
  applyDecisions?: (decisions: SweepDecision[]) => Promise<number>;
}

export async function runAssignSweep(deps: SweepDeps): Promise<SweepResult> {
  const olderThan = new Date(deps.now.getTime() - deps.settings.delayMinutes * 60_000);
  const candidates = await deps.listCandidates(olderThan, 200);
  const held = deps.settings.afterHours === "hold9am" && isAfterHours(deps.now);

  const decisions: SweepDecision[] = [];
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
  } else if (deps.applyDecisions && decisions.length > 0) {
    applied = await deps.applyDecisions(decisions);
    reason = "applied";
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
