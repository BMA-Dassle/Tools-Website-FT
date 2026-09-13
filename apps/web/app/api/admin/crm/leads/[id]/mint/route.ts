import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  EmptySchema,
  getLead,
  leadNumericId,
  mintBlocker,
  mintLead,
  mintOutcomeView,
} from "~/features/crm/leads";
import { listReps } from "~/features/crm/reps";

/**
 * POST /api/admin/crm/leads/[id]/mint → `{ok, lead, mint}`
 *
 * The deal's "Complete to create in BMI" / "Retry" action: mints the project
 * inline through the same `mintLead` the capture and the job use. An already
 * minted lead answers its existing project; a lead still missing email or
 * time answers 409 `needs_email_or_time` without calling Pandora. When the
 * lead already has an assignee, `agent` is that rep's Office name.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(EmptySchema, async ({ params, user }) => {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = raw ? leadNumericId(raw) : null;
  if (!id) throw new CrmHttpError(404, "lead_not_found");
  const lead = await getLead(id);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");
  if (lead.mintStatus === "minted") {
    return {
      lead,
      mint: {
        status: "minted" as const,
        error: null,
        projectId: lead.bmi.projectId,
        projectNumber: lead.bmi.projectNumber,
      },
    };
  }
  const blocker = mintBlocker(lead);
  if (blocker) throw new CrmHttpError(409, blocker);

  const rep = lead.rep ? ((await listReps()).find((r) => r.id === lead.rep) ?? null) : null;
  const { outcome, lead: after } = await mintLead(
    lead,
    { agent: rep?.bmiUsername ?? null },
    undefined,
    user.email,
  );
  await writeAudit({
    entity: "lead",
    entityId: lead.id,
    action: "mint",
    actorEmail: user.email,
    before: { mintStatus: lead.mintStatus, mintError: lead.mintError },
    after: mintOutcomeView(outcome),
  });
  return { lead: after, mint: mintOutcomeView(outcome) };
});
