/**
 * The Lead queue (direction-b.html `queue`): unassigned leads oldest first
 * with their age, the engine's pick and WHY they are still here, plus one
 * column per assignable rep with their open volume by party month and the
 * leads they were handed but have not touched.
 *
 * Since 2026-09-13 the rules assign at capture, so this board holds only
 * deliberately-parked leads — see `parkFor`. The prototype's "auto-assign in
 * 52m" countdown is gone with the delay it counted.
 *
 * Pure builders (tested) over the data functions; `loadQueue` wires them.
 *
 * The engine context (roster, rules, shifts, open volume) is loaded ONCE for
 * the whole board and handed to every `suggestFor` call — a queue of forty
 * leads must not be forty round trips. It is centre-agnostic by construction
 * (`rules/service/context.ts`), so one load covers all three centres; if it
 * fails, each lead still gets an answer (the engine seam degrades to "no
 * auto-pick" rather than 500ing the director's board).
 */

import { publicRep } from "../../core/projections";
import { getCrmSettings } from "../../core/data/settings-db";
import { shiftYmd, todayEasternYmd } from "../../core/dates";
import type { CrmRep } from "../../core/types";
import { assignableReps, listReps } from "~/features/crm/reps";
import { loadEngineContext, type EngineContext } from "~/features/crm/rules";
import type {
  LeadView,
  QueueLead,
  QueuePark,
  QueueRepColumn,
  QueueResponse,
  VolumeCell,
} from "../contracts";
import {
  listAssignedAwaitingTouch,
  listUnassignedLeads,
  volumeByRepMonth,
  type VolumeRow,
} from "../data/leads-db";
import { NO_SUGGESTION, suggestFor, type SuggestResult } from "./suggest";

export type QueueBody = Omit<QueueResponse, "ok">;

/** This ET month and the two after it — the volume meters' columns. */
export function queueMonths(todayYmd: string): string[] {
  const first = `${todayYmd.slice(0, 7)}-01`;
  return [0, 1, 2].map((i) => {
    // shift by whole months via the 1st + 32-day hops, then snap to the month
    let ymd = first;
    for (let k = 0; k < i; k++) ymd = `${shiftYmd(ymd, 32).slice(0, 7)}-01`;
    return ymd.slice(0, 7);
  });
}

export function ageMinutes(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
}

/**
 * WHY a lead is still on this board.
 *
 * There is no countdown any more. The rules assign at capture, so nothing sits
 * here waiting for a timer to run out — everything here was parked, and the
 * pill says by what:
 *
 *   held    a hold rule parked it with somebody who does not work leads (the
 *           Marketing Director). Only a human releases it; the safety-net
 *           sweep skips it by construction.
 *   no-rep  the engine named nobody — the fallback rule, or no rule matched.
 *           It needs a director, or a roster that changes.
 *   retry   the engine CAN name somebody, so the capture-time assign did not
 *           happen: it threw, or `CRM_AUTO_ASSIGN` was off when the lead came
 *           in. The sweep is the net under exactly this case.
 */
export function parkFor(
  lead: Pick<LeadView, "heldForRep">,
  suggestion: QueueLead["suggestion"],
  reps: readonly CrmRep[],
): QueuePark {
  if (lead.heldForRep) {
    const who = reps.find((r) => r.id === lead.heldForRep);
    return { kind: "held", label: `Held for ${who?.displayName ?? "a hold rule"}` };
  }
  if (!suggestion) return { kind: "no-rep", label: "No eligible rep — assign by hand" };
  return {
    kind: "retry",
    label: `Not assigned yet — the sweep will hand it to ${suggestion.rep.firstName}`,
  };
}

export function buildQueueLeads(
  unassigned: readonly LeadView[],
  suggestions: ReadonlyMap<string, SuggestResult>,
  reps: readonly CrmRep[],
  now: Date,
): QueueLead[] {
  return unassigned.map((lead) => {
    const s = suggestions.get(lead.id) ?? NO_SUGGESTION;
    const suggestion = s.suggestion
      ? {
          rep: publicRep(s.suggestion.rep)!,
          reason: s.suggestion.reason,
          ruleId: s.suggestion.ruleId,
          finalRuleCode: s.suggestion.finalRuleLabel,
        }
      : null;
    return {
      lead,
      ageMinutes: ageMinutes(lead.createdAt, now),
      suggestion,
      park: parkFor(lead, suggestion, reps),
      trace: s.trace,
    };
  });
}

export function buildRepColumns(
  reps: readonly CrmRep[],
  volume: readonly VolumeRow[],
  assigned: readonly LeadView[],
  months: readonly string[],
): QueueRepColumn[] {
  return assignableReps(reps)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || Number(a.id) - Number(b.id))
    .map((rep) => {
      const vol: Record<string, VolumeCell> = {};
      for (const m of months) vol[m] = { guests: 0, count: 0 };
      for (const v of volume) {
        if (v.repId === rep.id && vol[v.month]) vol[v.month] = { guests: v.guests, count: v.count };
      }
      return {
        rep: publicRep(rep)!,
        volume: vol,
        assigned: assigned.filter((l) => l.rep === rep.id),
      };
    });
}

export interface QueueDeps {
  listUnassigned: typeof listUnassignedLeads;
  listReps: typeof listReps;
  volume: typeof volumeByRepMonth;
  listAssigned: typeof listAssignedAwaitingTouch;
  suggest: typeof suggestFor;
  settings: typeof getCrmSettings;
  /** Loaded once per board; omitted by a test that injects its own `suggest`. */
  loadEngine?: typeof loadEngineContext;
  now: () => Date;
}

export function defaultQueueDeps(): QueueDeps {
  return {
    listUnassigned: listUnassignedLeads,
    listReps,
    volume: volumeByRepMonth,
    listAssigned: listAssignedAwaitingTouch,
    suggest: suggestFor,
    settings: getCrmSettings,
    loadEngine: loadEngineContext,
    now: () => new Date(),
  };
}

/**
 * One engine context for the whole board — or `undefined`, which makes each
 * `suggestFor` load its own (and, if that fails too, answer "no auto-pick").
 * The context does not depend on the centre, so the first lead's centre is
 * only what the load records on the result.
 */
async function loadEngineOnce(
  unassigned: readonly LeadView[],
  deps: QueueDeps,
  now: Date,
): Promise<EngineContext | undefined> {
  const first = unassigned[0];
  if (!first || !deps.loadEngine) return undefined;
  try {
    return await deps.loadEngine(first.centre, now);
  } catch (err) {
    console.error("[crm] the queue could not load the assignment context", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export async function loadQueue(deps: QueueDeps = defaultQueueDeps()): Promise<QueueBody> {
  const now = deps.now();
  const months = queueMonths(todayEasternYmd(now));
  const [unassigned, reps, settings] = await Promise.all([
    deps.listUnassigned(),
    deps.listReps(),
    deps.settings(),
  ]);
  const [volume, assigned] = await Promise.all([deps.volume(months), deps.listAssigned()]);
  const engine = await loadEngineOnce(unassigned, deps, now);
  const suggestions = new Map<string, SuggestResult>();
  for (const lead of unassigned) {
    suggestions.set(lead.id, await deps.suggest(lead, { now, reps, engine }));
  }
  return {
    unassigned: buildQueueLeads(unassigned, suggestions, reps, now),
    reps: buildRepColumns(reps, volume, assigned, months),
    months,
    sweepDelayMinutes: settings.sweep.delayMinutes,
  };
}
