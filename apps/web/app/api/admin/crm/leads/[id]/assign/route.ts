import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  LeadAssignSchema,
  LeadNotFoundError,
  RepNotAssignableError,
  assignLead,
  leadNumericId,
} from "~/features/crm/leads";

/**
 * POST /api/admin/crm/leads/[id]/assign — director only.
 *   {repId | null, note?} → `{ok, lead, assignment, bmi}`
 *
 * `crm_assignments` + the lead row + activity FIRST, then Office's
 * `responsible` through PR1's `putProjectFields` (verified re-read, per-project
 * lock, kill-switched). `bmi.status` says what happened to that last step:
 * synced · failed (job queued) · paused · no_project · no_bmi_user.
 * `repId: null` releases the lead back to the queue.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(
  LeadAssignSchema,
  async ({ input, params, user }) => {
    const raw = Array.isArray(params.id) ? params.id[0] : params.id;
    const id = raw ? leadNumericId(raw) : null;
    if (!id) throw new CrmHttpError(404, "lead_not_found");
    try {
      const result = await assignLead({
        leadId: id,
        repId: input.repId,
        actor: user.email,
        reason: "manual",
        note: input.note ?? null,
      });
      await writeAudit({
        entity: "lead",
        entityId: result.lead.id,
        action: input.repId ? "assign" : "release",
        actorEmail: user.email,
        before: { rep: result.assignment.fromRepId },
        after: {
          rep: result.assignment.toRepId,
          reason: result.assignment.reason,
          bmi: result.bmi,
        },
      });
      return { lead: result.lead, assignment: result.assignment, bmi: result.bmi };
    } catch (err) {
      if (err instanceof LeadNotFoundError) throw new CrmHttpError(404, "lead_not_found");
      if (err instanceof RepNotAssignableError) throw new CrmHttpError(400, err.message);
      throw err;
    }
  },
  { director: true },
);
