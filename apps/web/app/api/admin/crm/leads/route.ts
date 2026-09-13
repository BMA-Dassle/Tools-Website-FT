import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { isDirector } from "~/features/crm/core/identity";
import {
  LeadCreateSchema,
  LeadListQuerySchema,
  createLead,
  listLeads,
  mintOutcomeView,
} from "~/features/crm/leads";

/**
 * /api/admin/crm/leads (wire contract: `leads/contracts.ts`)
 *   GET  ?cursor&limit&status&rep&mine&centre&q&unassigned  → `{ok, leads, nextCursor}`
 *        keyset on (created_at, id), limit ≤ 200 (R10). A rep's `mine=1` is
 *        their own row; a director may pass `rep=`.
 *   POST {centre, source: phone|walkin|referral, firstName, lastName, phone, email?, …}
 *        → `{ok, lead, created, mint, assignment}` — a member of staff logging a
 *        lead by hand. Neon first; a lead without email or time is stored with
 *        `mint_status: "none"` / `needs_email_or_time` and NO Pandora call (the
 *        deal's "Complete to create in BMI" finishes it).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(LeadListQuerySchema, async ({ input, user }) => {
  const mine = input.mine === "1" || input.mine === "true";
  let repId = input.rep;
  if (mine) {
    if (!user.rep) return { leads: [], nextCursor: null };
    repId = user.rep.id;
  }
  const page = await listLeads({
    cursor: input.cursor,
    limit: input.limit,
    statusId: input.status,
    repId,
    centre: input.centre,
    q: input.q,
    unassigned: input.unassigned === "1" || input.unassigned === "true",
    includeArchived: input.includeArchived === "1" || input.includeArchived === "true",
  });
  return { leads: page.leads, nextCursor: page.nextCursor };
});

export const POST = withCrmRoute(LeadCreateSchema, async ({ input, user }) => {
  const result = await createLead(
    {
      centre: input.centre,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email ?? null,
      company: input.company ?? null,
      eventDate: input.eventDate,
      eventTime: input.eventTime ?? null,
      guests: input.guests,
      type: input.type,
      kids: input.kids ?? false,
      notes: input.notes ?? null,
      prefers: input.prefers ?? null,
      capturePayload: { ...input, token: undefined },
      createdBy: user.email,
    },
    { source: input.source, actorEmail: user.email },
  );
  if (!result.lead) throw new CrmHttpError(500, "lead_not_created");
  await writeAudit({
    entity: "lead",
    entityId: result.lead.id,
    action: result.created ? "create" : "create:duplicate",
    actorEmail: user.email,
    after: {
      publicId: result.lead.publicId,
      source: input.source,
      mint: result.mint.status,
      director: isDirector(user),
    },
  });
  return {
    lead: result.lead,
    created: result.created,
    mint: mintOutcomeView(result.mint),
    assignment: result.assignment?.assignment ?? null,
  };
});
