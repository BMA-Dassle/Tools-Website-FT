/**
 * The `mint-bmi-project` job (brief §3.9): whatever BMI bookkeeping a lead
 * still owes — the project mint itself (`task: "mint"`) or the `responsible`
 * PUT after a hand-off that could not reach Office (`task: "responsible"`).
 *
 * One kind for both because `JOB_KINDS` is a PR1 constant (append-only file)
 * and both are "reconcile this lead with BMI": idempotent, per-lead keyed,
 * safe to re-run. Registered on the registry's `mint-bmi-project` line via a
 * dynamic import of this sub's barrel, so `jobs → leads → jobs` is never a
 * static cycle.
 *
 * Verdicts: `ok` when the lead is (already) where it should be; `{ok:false}`
 * to retry with backoff; `park` for things a retry cannot fix (no such lead,
 * the lead cannot be minted until a human adds email / time, the assignment
 * was superseded).
 */

import type { JobContext, JobOutcome } from "~/features/crm/jobs";
import { listReps } from "~/features/crm/reps";
import { getLead } from "../data/leads-db";
import { listAssignments } from "../data/assignments-db";
import { defaultAssignDeps, syncResponsible, type AssignDeps } from "./assign";
import { defaultMintLeadDeps, mintBlocker, mintLead, type MintLeadDeps } from "./mint";

export interface LeadBmiJobDeps {
  getLead: typeof getLead;
  listReps: typeof listReps;
  listAssignments: typeof listAssignments;
  mintLead: typeof mintLead;
  mintDeps: () => MintLeadDeps;
  syncResponsible: typeof syncResponsible;
  assignDeps: () => AssignDeps;
}

export function defaultLeadBmiJobDeps(): LeadBmiJobDeps {
  return {
    getLead,
    listReps,
    listAssignments,
    mintLead,
    mintDeps: defaultMintLeadDeps,
    syncResponsible,
    assignDeps: defaultAssignDeps,
  };
}

export async function runLeadBmiJob(
  ctx: JobContext,
  deps: LeadBmiJobDeps = defaultLeadBmiJobDeps(),
): Promise<JobOutcome> {
  const leadId = typeof ctx.payload.leadId === "string" ? ctx.payload.leadId : null;
  const task = ctx.payload.task === "responsible" ? "responsible" : "mint";
  if (!leadId) return { ok: false, error: "payload.leadId missing", park: true };
  const lead = await deps.getLead(leadId);
  if (!lead) return { ok: false, error: `lead ${leadId} not found`, park: true };
  const actor = ctx.actorEmail ?? "cron";

  if (task === "mint") {
    if (lead.mintStatus === "minted") {
      return { ok: true, result: { leadId, already: "minted", projectId: lead.bmi.projectId } };
    }
    const blocker = mintBlocker(lead);
    if (blocker) return { ok: false, error: `cannot mint: ${blocker}`, park: true };
    const reps = lead.rep ? await deps.listReps() : [];
    const rep = reps.find((r) => r.id === lead.rep) ?? null;
    const { outcome } = await deps.mintLead(
      lead,
      { agent: rep?.bmiUsername ?? null },
      deps.mintDeps(),
      actor,
    );
    if (outcome.status === "minted") {
      return {
        ok: true,
        result: { leadId, projectId: outcome.projectId, projectNumber: outcome.projectNumber },
      };
    }
    return {
      ok: false,
      error: outcome.status === "failed" ? outcome.error : `cannot mint: ${outcome.error}`,
    };
  }

  // task === "responsible"
  const assignmentId =
    typeof ctx.payload.assignmentId === "string" ? ctx.payload.assignmentId : null;
  const repId = typeof ctx.payload.repId === "string" ? ctx.payload.repId : lead.rep;
  if (!repId || lead.rep !== repId)
    return { ok: false, error: "assignment superseded", park: true };
  const assignments = await deps.listAssignments(lead.id, 20);
  const assignment = assignmentId ? assignments.find((a) => a.id === assignmentId) : assignments[0];
  if (!assignment) return { ok: false, error: "assignment row missing", park: true };
  if (assignment.bmiResponsibleSyncedAt) {
    return { ok: true, result: { leadId, already: "synced", assignmentId: assignment.id } };
  }
  if (!lead.bmi.projectId) return { ok: false, error: "lead has no BMI project yet" };
  const rep = (await deps.listReps()).find((r) => r.id === repId);
  if (!rep) return { ok: false, error: `rep ${repId} not found`, park: true };
  const bmi = await deps.syncResponsible(lead, rep, assignment, actor, deps.assignDeps());
  if (bmi.status === "synced")
    return { ok: true, result: { leadId, assignmentId: assignment.id, bmi } };
  if (bmi.status === "no_bmi_user")
    return { ok: false, error: "rep has no Office user id", park: true };
  return {
    ok: false,
    error: bmi.status === "failed" ? (bmi.error ?? "office write failed") : bmi.status,
  };
}
