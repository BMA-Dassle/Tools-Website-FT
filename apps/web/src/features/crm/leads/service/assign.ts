/**
 * `assignLead` — a hand-off, in this order (R2, R5):
 *
 *   1. `crm_assignments` row (from → to, actor, reason, rule trace, note)
 *   2. `crm_leads`: assigned_rep_id / assigned_at / status 'assigned' (only
 *      from 'new' — a reassign never regresses a contacted lead) and the first
 *      next action ("New lead — first touch due" in `response_target_minutes`)
 *   3. activity `assign`
 *   4. Office `responsible` through `putProjectFields` — PR1's single writer
 *      for project fields (GET → minimal PUT → 403 confirm-once → VERIFIED
 *      re-read, under the per-project Redis lock). Kill-switched by
 *      `bmiWritesAllowedFor` (env + the director's Neon toggle; no row = ON).
 *      Success stamps `crm_assignments.bmi_responsible_synced_at`; failure
 *      leaves it NULL, writes a system activity and enqueues the lead's BMI
 *      reconcile job with a per-assignment key — one row, no retry storm.
 *
 * Never a second PUT rail, never `updateProjectResponsible`, never a
 * `serializeWithRawIds` PUT of the project.
 *
 * `reason` normalises itself: "manual" onto an already-assigned lead is a
 * "reassign"; `repId: null` is a "release" back to the queue.
 */

import { putProjectFields } from "@/lib/bmi-office-actions";
import { recordActivity } from "~/features/crm/activities";
import { neonJobStore, type JobStore } from "~/features/crm/jobs";
import { listReps } from "~/features/crm/reps";
import { centreByCode } from "../../core/centres";
import { getSettingValue } from "../../core/data/settings-db";
import { bmiWritesAllowedFor } from "../../core/flags";
import { responseTargetFromSetting } from "../../core/settings";
import type { CrmRep, NextAction } from "../../core/types";
import type {
  AssignmentReason,
  BmiResponsibleSyncOutcome,
  LeadAssignmentView,
  LeadView,
  RuleTraceRowView,
} from "../contracts";
import { insertAssignment, markAssignmentResponsibleSynced } from "../data/assignments-db";
import { getLead, updateLeadFields } from "../data/leads-db";
import { MINT_JOB_KIND } from "./mint";

export const FIRST_TOUCH_LABEL = "New lead — first touch due";

export class LeadNotFoundError extends Error {
  constructor(id: string) {
    super(`lead ${id} not found`);
    this.name = "LeadNotFoundError";
  }
}

export class RepNotAssignableError extends Error {
  constructor(repId: string, why: string) {
    super(`rep ${repId} cannot be assigned: ${why}`);
    this.name = "RepNotAssignableError";
  }
}

export interface AssignLeadInput {
  leadId: string;
  /** null = release back to the queue. */
  repId: string | null;
  /** The signed-in email (or "system" / the job) — recorded as actor_email. */
  actor: string;
  reason: AssignmentReason;
  ruleId?: string | null;
  trace?: RuleTraceRowView[] | null;
  note?: string | null;
}

export interface AssignResult {
  lead: LeadView;
  assignment: LeadAssignmentView;
  bmi: BmiResponsibleSyncOutcome;
}

export interface AssignDeps {
  getLead: typeof getLead;
  listReps: typeof listReps;
  insertAssignment: typeof insertAssignment;
  updateLeadFields: typeof updateLeadFields;
  markSynced: typeof markAssignmentResponsibleSynced;
  recordActivity: typeof recordActivity;
  putProjectFields: typeof putProjectFields;
  getSettingValue: typeof getSettingValue;
  jobs: Pick<JobStore, "enqueue">;
  now: () => Date;
}

export function defaultAssignDeps(): AssignDeps {
  return {
    getLead,
    listReps,
    insertAssignment,
    updateLeadFields,
    markSynced: markAssignmentResponsibleSynced,
    recordActivity,
    putProjectFields,
    getSettingValue,
    jobs: neonJobStore,
    now: () => new Date(),
  };
}

/** The first next action after a hand-off (crm-shared.js:242). */
export function nextActionForAssignment(now: Date, targetMinutes: number): NextAction {
  return {
    kind: "call",
    due: new Date(now.getTime() + targetMinutes * 60_000).toISOString(),
    label: FIRST_TOUCH_LABEL,
  };
}

/** "manual" onto an assigned lead → "reassign"; a null rep → "release". */
export function normalizeReason(
  reason: AssignmentReason,
  lead: Pick<LeadView, "rep">,
  repId: string | null,
): AssignmentReason {
  if (repId === null) return "release";
  if (reason === "manual" && lead.rep && lead.rep !== repId) return "reassign";
  return reason;
}

export async function assignLead(
  input: AssignLeadInput,
  deps: AssignDeps = defaultAssignDeps(),
): Promise<AssignResult> {
  const lead = await deps.getLead(input.leadId);
  if (!lead) throw new LeadNotFoundError(input.leadId);

  let rep: CrmRep | null = null;
  if (input.repId !== null) {
    const reps = await deps.listReps();
    rep = reps.find((r) => r.id === input.repId) ?? null;
    if (!rep) throw new RepNotAssignableError(input.repId, "no such rep");
    if (!rep.active) throw new RepNotAssignableError(input.repId, "inactive");
    if (rep.role === "director") throw new RepNotAssignableError(input.repId, "a director");
  }

  const now = deps.now();
  const reason = normalizeReason(input.reason, lead, input.repId);

  // 1. the hand-off row
  const assignment = await deps.insertAssignment({
    leadId: lead.id,
    fromRepId: lead.rep,
    toRepId: rep?.id ?? null,
    actorEmail: input.actor,
    reason,
    ruleId: input.ruleId ?? null,
    trace: input.trace ?? null,
    note: input.note ?? null,
  });

  // 2. the lead row
  const targetMinutes = responseTargetFromSetting(
    await deps.getSettingValue("response_target_minutes"),
  );
  const next = rep && !lead.firstTouchAt ? nextActionForAssignment(now, targetMinutes) : null;
  const after =
    (await deps.updateLeadFields(lead.id, {
      assignedRepId: rep?.id ?? null,
      assignedAt: rep ? now : null,
      heldForRepId: rep?.role === "hold" ? rep.id : null,
      statusId: rep
        ? lead.status === "new"
          ? "assigned"
          : lead.status
        : lead.status === "assigned"
          ? "new"
          : lead.status,
      ...(next
        ? { nextActionKind: next.kind, nextActionDue: next.due, nextActionLabel: next.label }
        : rep
          ? {}
          : { nextActionKind: null, nextActionDue: null, nextActionLabel: null }),
    })) ?? lead;

  // 3. the diary line
  const line = rep
    ? lead.rep && lead.rep !== rep.id
      ? `Reassigned to ${rep.firstName} by ${input.actor}`
      : reason === "rule" || reason === "auto"
        ? `Auto-assigned to ${rep.firstName} (${reason})`
        : `Assigned to ${rep.firstName} by ${input.actor}`
    : `Released to the queue by ${input.actor}`;
  await deps.recordActivity({
    leadId: lead.id,
    contactId: lead.contactId,
    repId: rep?.id ?? null,
    actorEmail: input.actor,
    kind: "assign",
    occurredAt: now,
    body: input.note ? `${line} · ${input.note}` : line,
    meta: {
      reason,
      fromRepId: lead.rep,
      toRepId: rep?.id ?? null,
      ruleId: input.ruleId ?? null,
      trace: input.trace ?? null,
      assignmentId: assignment.id,
    },
  });

  // 4. Office responsible — the single writer
  const bmi = rep
    ? await syncResponsible(after, rep, assignment, input.actor, deps)
    : { status: "skipped" as const };

  const refreshed = (await deps.getLead(lead.id)) ?? after;
  return {
    lead: refreshed,
    assignment: {
      ...assignment,
      ...(bmi.status === "synced" ? { bmiResponsibleSyncedAt: now.toISOString() } : {}),
    },
    bmi,
  };
}

/**
 * `putProjectFields({userId, userAgentId})` for one hand-off. Exported so the
 * lead's BMI reconcile job (`mint-bmi-project`) can retry exactly this step.
 */
export async function syncResponsible(
  lead: LeadView,
  rep: CrmRep,
  assignment: Pick<LeadAssignmentView, "id">,
  actor: string,
  deps: AssignDeps = defaultAssignDeps(),
): Promise<BmiResponsibleSyncOutcome> {
  const projectId = lead.bmi.projectId;
  if (!projectId) return { status: "no_project" };
  if (!rep.bmiUserId) return { status: "no_bmi_user" };

  const clientKey = centreByCode(lead.centre).clientKey;
  const setting = await deps.getSettingValue("bmi_writes");
  const now = deps.now();
  if (!bmiWritesAllowedFor(clientKey, setting)) {
    await deps.recordActivity({
      leadId: lead.id,
      repId: rep.id,
      actorEmail: actor,
      kind: "system",
      occurredAt: now,
      body: `BMI responsible not updated — writes are paused for ${clientKey}`,
      meta: { assignmentId: assignment.id, paused: true },
    });
    return { status: "paused" };
  }

  try {
    await deps.putProjectFields({
      clientKey,
      projectId,
      patch: { userId: rep.bmiUserId, userAgentId: rep.bmiUserId },
    });
    await deps.markSynced(assignment.id, now);
    await deps.updateLeadFields(lead.id, { bmiSyncedAt: now });
    await deps.recordActivity({
      leadId: lead.id,
      repId: rep.id,
      actorEmail: actor,
      kind: "bmi",
      occurredAt: now,
      body: `BMI responsible → ${rep.bmiUsername ?? rep.displayName} (verified)`,
      meta: { assignmentId: assignment.id, userId: rep.bmiUserId, projectId },
    });
    return { status: "synced" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await deps.recordActivity({
      leadId: lead.id,
      repId: rep.id,
      actorEmail: actor,
      kind: "system",
      occurredAt: now,
      body: `BMI responsible not updated — ${error} (queued for retry)`,
      meta: { assignmentId: assignment.id, error },
    });
    try {
      await deps.jobs.enqueue({
        kind: MINT_JOB_KIND,
        idempotencyKey: `${MINT_JOB_KIND}:${lead.id}:responsible:${assignment.id}`,
        payload: {
          leadId: lead.id,
          task: "responsible",
          assignmentId: assignment.id,
          repId: rep.id,
        },
        createdBy: actor,
      });
    } catch (enqueueErr) {
      console.error("[crm] could not enqueue responsible retry", {
        lead_id: lead.id,
        actor_email: actor,
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      });
    }
    return { status: "failed", error };
  }
}
