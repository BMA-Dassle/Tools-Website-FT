import { listLeadTimeline } from "~/features/crm/activities";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  EmptySchema,
  LeadPatchSchema,
  getLead,
  leadNumericId,
  listAssignments,
  patchContact,
  updateLeadFields,
  type LeadPatch,
} from "~/features/crm/leads";
import { publicRoster } from "~/features/crm/reps";

/**
 * /api/admin/crm/leads/[id]   (id = `L-123` or `123`)
 *   GET   → `{ok, lead, activities, assignments, reps}` — the deal in one read.
 *   PATCH {eventDate?, eventTime?, guests?, type?, kids?, notes?, valueCents?, contact?:{…}}
 *         → `{ok, lead}`; contact edits go to crm_contacts, the rest to crm_leads;
 *         `crm_audit` records before / after with the signed-in actor.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = raw ? leadNumericId(raw) : null;
  if (!id) throw new CrmHttpError(404, "lead_not_found");
  return id;
}

export const GET = withCrmRoute(EmptySchema, async ({ params }) => {
  const id = idFrom(params);
  const lead = await getLead(id);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");
  const [timeline, assignments, reps] = await Promise.all([
    listLeadTimeline(lead.id, { limit: 100 }),
    listAssignments(lead.id),
    publicRoster(),
  ]);
  return { lead, activities: timeline.activities, assignments, reps };
});

export const PATCH = withCrmRoute(LeadPatchSchema, async ({ input, params, user }) => {
  const id = idFrom(params);
  const before = await getLead(id);
  if (!before) throw new CrmHttpError(404, "lead_not_found");

  if (input.contact && before.contactId) {
    await patchContact(before.contactId, {
      firstName: input.contact.firstName,
      lastName: input.contact.lastName,
      phoneE164: input.contact.phone === undefined ? undefined : input.contact.phone,
      email: input.contact.email,
      prefers: input.contact.prefers,
    });
  }

  const patch: LeadPatch = {};
  if (input.eventDate !== undefined) patch.eventDate = input.eventDate;
  if (input.eventTime !== undefined) patch.eventTime = input.eventTime;
  if (input.guests !== undefined) patch.guests = input.guests;
  if (input.type !== undefined) patch.type = input.type;
  if (input.kids !== undefined) patch.kids = input.kids;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.valueCents !== undefined) patch.valueCents = input.valueCents;

  const lead = Object.keys(patch).length ? await updateLeadFields(id, patch) : await getLead(id);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");
  await writeAudit({
    entity: "lead",
    entityId: lead.id,
    action: "update",
    actorEmail: user.email,
    before: { lead: before, contact: before.guest },
    after: { lead, contact: lead.guest },
  });
  return { lead };
});
