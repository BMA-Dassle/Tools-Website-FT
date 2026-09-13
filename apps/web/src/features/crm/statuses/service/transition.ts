/**
 * `transition()` — THE ONLY WRITER of `crm_leads.status_id` (brief §4 B4).
 * A drag on the board, the deal's status sheet and a logged call that advances
 * "Assigned → Contacted" all come through here, in this order (R2, R5):
 *
 *   1. Neon: `crm_leads.status_id` (+ `lost_reason` when the new status is a
 *      lost one), then an activity `kind:'status'` carrying from → to. The CRM
 *      is the source of truth and it moves FIRST — an Office outage never
 *      loses the rep's decision.
 *   2. Office, only when every one of the four conditions holds (see
 *      `bmi-state.ts` for the branch table): the lead has a project, the
 *      status is mapped for THIS tenant, writes are not paused, and the mapped
 *      id is a custom (positive) one.
 *
 * THE OFFICE RAIL IS `putProjectFields` — PR1's single project-field writer
 * (R5), which holds the per-project Redis lock `crm:office:project:<id>`,
 * reads through `fetchProjectRawIds` (precision-safe, R1), sends the minimal
 * project through `projectPutJson`, answers Office's 403 confirm prompt once,
 * and VERIFIES by re-read.
 *
 * A DELIBERATE DEVIATION FROM THE BRIEF'S LETTER, recorded here rather than
 * buried: the brief names `setProjectState` for custom ids "under the same
 * per-project Redis lock `putProjectFields` uses". That lock is private to
 * `lib/bmi-office-actions.ts` (only the key PREFIX is exported) and that file
 * is PR1's to edit, so a caller cannot hold it around `setProjectState`.
 * Worse, `setProjectState`'s custom-id path bare-`JSON.parse`s the project it
 * reads (`bmi-office-actions.ts:509`) — precisely the reader R1 forbids the
 * CRM to use — and PUTs without `projectPutJson`. `putProjectFields({patch:
 * {stateId}})` does the same GET → minimal PUT → verify on the SAME private
 * `putProject`, with the lock, with the precision-safe read, and its own
 * header names `stateId` as one of the fields it is for. Using it keeps R5's
 * "one writer per BMI entity" literally true instead of adding a second,
 * unlocked rail. Recorded as an owner item.
 *
 * WHAT A 200 IS NOT: proof. `putProjectFields` already re-reads, but Office
 * propagates a state write to Firebird asynchronously, so a verify that fails
 * on the first read is retried by re-reading — never by writing again. Only
 * when the state still reads wrong does the transition report `pending`:
 * Neon has moved, the deal wears the chip, and B1's delta sync reconciles.
 */

import { fetchProjectRawIds, putProjectFields } from "@/lib/bmi-office-actions";
import { recordActivity } from "~/features/crm/activities";
import { getLead, updateLeadFields } from "~/features/crm/leads";
import type { LeadView } from "~/features/crm/leads/contracts";
import { centreByCode } from "../../core/centres";
import { getSettingValue } from "../../core/data/settings-db";
import { bmiWritesAllowedFor } from "../../core/flags";
import type { CrmStatus } from "../../core/types";
import { getStatus } from "../data/statuses-db";
import { getStatusMapping } from "../data/status-map-db";
import { bmiStateBranch, type BmiStateSyncOutcome } from "./bmi-state";

export class StatusNotFoundError extends Error {
  constructor(statusId: string) {
    super(`status ${statusId} does not exist`);
    this.name = "StatusNotFoundError";
  }
}

export class StatusUnchangedError extends Error {
  constructor(statusId: string) {
    super(`lead is already in ${statusId}`);
    this.name = "StatusUnchangedError";
  }
}

/** How many times the state is RE-READ (never re-written) before giving up. */
export const STATE_CONFIRM_ATTEMPTS = 3;
export const STATE_CONFIRM_GAP_MS = 1200;

export interface TransitionInput {
  lead: LeadView;
  toStatusId: string;
  /** The signed-in email — `actor_email` on the activity and the audit row. */
  actor: string;
  /** Required by the UI when the new status is a lost one; free text otherwise. */
  lostReason?: string | null;
  note?: string | null;
}

export interface TransitionResult {
  lead: LeadView;
  status: CrmStatus;
  from: string;
  bmi: BmiStateSyncOutcome;
}

export interface TransitionDeps {
  getLead: typeof getLead;
  getStatus: typeof getStatus;
  getStatusMapping: typeof getStatusMapping;
  updateLeadFields: typeof updateLeadFields;
  recordActivity: typeof recordActivity;
  getSettingValue: typeof getSettingValue;
  putProjectFields: typeof putProjectFields;
  fetchProjectRawIds: typeof fetchProjectRawIds;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export function defaultTransitionDeps(): TransitionDeps {
  return {
    getLead,
    getStatus,
    getStatusMapping,
    updateLeadFields,
    recordActivity,
    getSettingValue,
    putProjectFields,
    fetchProjectRawIds,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** "Contacted → Quote sent" — what the activity row reads on the timeline. */
export function transitionLine(from: CrmStatus | null, to: CrmStatus, actor: string): string {
  return `${from?.label ?? from ?? "—"} → ${to.label} by ${actor}`;
}

export async function transition(
  input: TransitionInput,
  deps: TransitionDeps = defaultTransitionDeps(),
): Promise<TransitionResult> {
  const { lead, toStatusId, actor } = input;
  const to = await deps.getStatus(toStatusId);
  if (!to || to.archivedAt) throw new StatusNotFoundError(toStatusId);
  if (lead.status === toStatusId) throw new StatusUnchangedError(toStatusId);
  const from = await deps.getStatus(lead.status);
  const now = deps.now();

  // 1. Neon first — the CRM's own truth, never gated on Office.
  await deps.updateLeadFields(lead.id, {
    statusId: to.id,
    ...(to.kind === "lost"
      ? { lostReason: input.lostReason ?? lead.lostReason ?? null }
      : { lostReason: null }),
  });
  await deps.recordActivity({
    leadId: lead.id,
    contactId: lead.contactId,
    repId: lead.rep,
    actorEmail: actor,
    kind: "status",
    occurredAt: now,
    body: input.note
      ? `${transitionLine(from, to, actor)} · ${input.note}`
      : transitionLine(from, to, actor),
    meta: { from: lead.status, to: to.id, kind: to.kind },
  });

  // 2. Office, when the branch says so.
  const bmi = await syncBmiState(lead, to, actor, deps);

  const refreshed = (await deps.getLead(lead.id)) ?? lead;
  return { lead: refreshed, status: to, from: lead.status, bmi };
}

/**
 * The Office half. Exported so a later reconcile job can retry exactly this
 * step for a lead left `pending`, without re-running the Neon half.
 */
export async function syncBmiState(
  lead: LeadView,
  to: CrmStatus,
  actor: string,
  deps: TransitionDeps = defaultTransitionDeps(),
): Promise<BmiStateSyncOutcome> {
  const clientKey = centreByCode(lead.centre).clientKey;
  const projectId = lead.bmi.projectId;
  const mapping = await deps.getStatusMapping(to.id, clientKey);
  const writesAllowed = bmiWritesAllowedFor(clientKey, await deps.getSettingValue("bmi_writes"));
  const branch = bmiStateBranch({ projectId, mapping, writesAllowed });
  const now = deps.now();

  if (branch !== "write") {
    // Every non-writing branch leaves a line on the timeline saying WHY, so a
    // deal that did not move in Office can always answer "what happened?".
    const why =
      branch === "no_project"
        ? "no BMI project yet"
        : branch === "unmapped"
          ? `no Office state mapped for ${to.label} at ${clientKey}`
          : branch === "paused"
            ? `BMI writes are paused for ${clientKey}`
            : `${to.label} maps to built-in state ${mapping?.bmiStateId} — set from the Contract tab`;
    await deps.recordActivity({
      leadId: lead.id,
      repId: lead.rep,
      actorEmail: actor,
      kind: "system",
      occurredAt: now,
      body: `BMI state not written — ${why}`,
      meta: { branch, statusId: to.id, stateId: mapping?.bmiStateId ?? null },
    });
    return {
      status: branch,
      stateId: mapping?.bmiStateId ?? null,
      stateName: mapping?.bmiStateName ?? null,
    };
  }

  const stateId = mapping!.bmiStateId;
  const stateName = mapping!.bmiStateName;
  try {
    await deps.putProjectFields({ clientKey, projectId: projectId!, patch: { stateId } });
  } catch (err) {
    // `putProjectFields` verifies by re-read; a state write propagates
    // asynchronously, so a first-read miss is re-READ, never re-written.
    const confirmed = await confirmState(clientKey, projectId!, stateId, deps);
    if (!confirmed) {
      const error = err instanceof Error ? err.message : String(err);
      await deps.recordActivity({
        leadId: lead.id,
        repId: lead.rep,
        actorEmail: actor,
        kind: "system",
        occurredAt: now,
        body: `BMI state → ${stateName} not confirmed — ${error} (sync pending)`,
        meta: { statusId: to.id, stateId, projectId, error },
      });
      return { status: "pending", stateId, stateName, error };
    }
  }

  await deps.updateLeadFields(lead.id, {
    bmiStateId: stateId,
    bmiStateName: stateName,
    bmiSyncedAt: now,
  });
  await deps.recordActivity({
    leadId: lead.id,
    repId: lead.rep,
    actorEmail: actor,
    kind: "bmi",
    occurredAt: now,
    body: `BMI state → ${stateName} (verified)`,
    meta: { statusId: to.id, stateId, projectId },
  });
  return { status: "write", stateId, stateName };
}

/** Re-READ the project up to `STATE_CONFIRM_ATTEMPTS` times. Never writes. */
async function confirmState(
  clientKey: string,
  projectId: string,
  stateId: string,
  deps: TransitionDeps,
): Promise<boolean> {
  for (let i = 0; i < STATE_CONFIRM_ATTEMPTS; i++) {
    await deps.sleep(STATE_CONFIRM_GAP_MS);
    try {
      const project = await deps.fetchProjectRawIds(clientKey, projectId);
      if (project && String(project.stateId ?? "") === stateId) return true;
    } catch {
      // An unreadable project is not proof either way — try again, then give up.
    }
  }
  return false;
}
