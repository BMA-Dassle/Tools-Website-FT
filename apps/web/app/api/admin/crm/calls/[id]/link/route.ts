import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { CallIdSchema, CallLinkSchema, getCall, linkCall } from "~/features/crm/calls";
import { getLead } from "~/features/crm/leads";
import { recordActivity } from "~/features/crm/activities";

/**
 * POST /api/admin/crm/calls/[id]/link
 *   {leadId} → `{ok, call}`
 *
 * "Link to a lead" from the unknown-callers banner (`crm-shared.js:423`). The
 * call takes the lead's contact and, when it had none, the lead's assignee —
 * never overwriting a rep the extension already identified — and a `call`
 * activity appears on that lead's timeline so the link is visible where the
 * work happens.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(CallLinkSchema, async ({ input, params, user }) => {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const parsed = CallIdSchema.safeParse(raw ?? "");
  if (!parsed.success) throw new CrmHttpError(404, "call_not_found");

  const before = await getCall(parsed.data);
  if (!before) throw new CrmHttpError(404, "call_not_found");

  const lead = await getLead(input.leadId);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");

  const call = await linkCall(parsed.data, {
    leadId: lead.id,
    contactId: lead.contactId,
    repId: lead.rep,
  });
  if (!call) throw new CrmHttpError(404, "call_not_found");

  await recordActivity({
    leadId: lead.id,
    contactId: lead.contactId,
    repId: call.repId,
    actorEmail: user.email,
    kind: "call",
    direction: call.direction,
    occurredAt: call.startedAt ?? call.createdAt,
    durationSeconds: call.durationSeconds,
    outcome: call.status,
    subject: "Call linked from the unknown callers tray",
    externalKind: "crm-call-link",
    externalRef: `call:${call.id}`,
    meta: { threecxCallId: call.threecxCallId, number: call.fromE164 ?? call.toE164 },
  });

  await writeAudit({
    entity: "call",
    entityId: call.id,
    action: "link",
    actorEmail: user.email,
    before: { leadId: before.leadId },
    after: { leadId: call.leadId, leadPublicId: call.leadPublicId },
  });

  return { call };
});
