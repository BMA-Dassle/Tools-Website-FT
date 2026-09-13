/**
 * The Lead queue (direction-b.html `queue`): unassigned leads oldest first
 * with their age and the engine's pick, plus one column per assignable rep
 * with their open volume by party month and the leads they were handed but
 * have not touched.
 *
 * Pure builders (tested) over the data functions; `loadQueue` wires them.
 * Shift chips ("On shift" / "Off today" / "Next 9 AM tomorrow") are B2's
 * roster; the column shows none until that lands.
 */

import { publicRep } from "../../core/projections";
import { getCrmSettings } from "../../core/data/settings-db";
import { shiftYmd, todayEasternYmd } from "../../core/dates";
import type { CrmRep } from "../../core/types";
import { assignableReps, listReps } from "~/features/crm/reps";
import type { LeadView, QueueLead, QueueRepColumn, QueueResponse, VolumeCell } from "../contracts";
import {
  listAssignedAwaitingTouch,
  listUnassignedLeads,
  volumeByRepMonth,
  type VolumeRow,
} from "../data/leads-db";
import { suggestFor, type SuggestResult } from "./suggest";

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

/** Minutes until the sweep would take the OLDEST waiting lead; 0 when overdue; null when nothing waits. */
export function autoAssignInMinutes(
  unassigned: readonly { createdAt: string }[],
  delayMinutes: number,
  now: Date,
): number | null {
  if (unassigned.length === 0) return null;
  const oldest = Math.max(...unassigned.map((l) => ageMinutes(l.createdAt, now)));
  return Math.max(0, delayMinutes - oldest);
}

export function buildQueueLeads(
  unassigned: readonly LeadView[],
  suggestions: ReadonlyMap<string, SuggestResult>,
  now: Date,
): QueueLead[] {
  return unassigned.map((lead) => {
    const s = suggestions.get(lead.id) ?? { suggestion: null, trace: [] };
    return {
      lead,
      ageMinutes: ageMinutes(lead.createdAt, now),
      suggestion: s.suggestion
        ? {
            rep: publicRep(s.suggestion.rep)!,
            reason: s.suggestion.reason,
            ruleId: s.suggestion.ruleId,
          }
        : null,
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
    now: () => new Date(),
  };
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
  const suggestions = new Map<string, SuggestResult>();
  for (const lead of unassigned) suggestions.set(lead.id, await deps.suggest(lead, { now, reps }));
  return {
    unassigned: buildQueueLeads(unassigned, suggestions, now),
    reps: buildRepColumns(reps, volume, assigned, months),
    months,
    autoAssignInMinutes: autoAssignInMinutes(unassigned, settings.sweep.delayMinutes, now),
    sweepDelayMinutes: settings.sweep.delayMinutes,
  };
}
