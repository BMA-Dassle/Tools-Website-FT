import { recordActivity } from "~/features/crm/activities";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { EmptySchema, getLead, leadNumericId, updateLeadFields } from "~/features/crm/leads";

/**
 * POST /api/admin/crm/leads/[id]/archive — director only → `{ok, lead}`
 *
 * Soft delete (`archived_at`): the row, its capture and its timeline stay;
 * the lead leaves every board and count. This is the clean-up step of the
 * preview smoke ("archive the test lead") — nothing is written to BMI here;
 * cancelling a minted test project is B5's cancel action.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(
  EmptySchema,
  async ({ params, user }) => {
    const raw = Array.isArray(params.id) ? params.id[0] : params.id;
    const id = raw ? leadNumericId(raw) : null;
    if (!id) throw new CrmHttpError(404, "lead_not_found");
    const before = await getLead(id);
    if (!before) throw new CrmHttpError(404, "lead_not_found");
    if (before.archivedAt) return { lead: before };
    const lead = (await updateLeadFields(id, { archivedAt: new Date() })) ?? before;
    await recordActivity({
      leadId: lead.id,
      contactId: lead.contactId,
      actorEmail: user.email,
      kind: "system",
      body: `Archived by ${user.email}`,
    });
    await writeAudit({
      entity: "lead",
      entityId: lead.id,
      action: "archive",
      actorEmail: user.email,
      before: { archivedAt: before.archivedAt },
      after: { archivedAt: lead.archivedAt },
    });
    return { lead };
  },
  { director: true },
);
