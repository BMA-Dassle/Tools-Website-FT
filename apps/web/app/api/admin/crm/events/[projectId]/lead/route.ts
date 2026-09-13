import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  CreateLeadFromEventSchema,
  ProjectIdSchema,
  createLeadFromEvent,
  withEventsErrors,
} from "~/features/crm/events";

/**
 * POST /api/admin/crm/events/<projectId>/lead → `{ok, lead, created}`
 *
 * "Create lead from event" on the Events board: a CRM row for a booking that
 * is ALREADY in BMI.
 *
 * It deliberately does NOT go through `POST /leads`, which mints — a mint here
 * would put a second project on the same day for the same guest. `createLead`
 * is called with `mint: false`, the existing project's ids are written onto
 * the row, and `mint_status` is set to `minted` because it is.
 *
 * It does not auto-assign either: the responsible sync writes to the live
 * Office project, and that is a hand-over a human makes, on the record.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(CreateLeadFromEventSchema, async ({ input, params, user }) =>
  withEventsErrors(async () => {
    const raw = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
    const parsed = ProjectIdSchema.safeParse(raw ?? "");
    if (!parsed.success) throw new CrmHttpError(404, "project_not_found");
    return {
      ...(await createLeadFromEvent({
        centre: input.centre,
        projectId: parsed.data,
        firstName: input.firstName,
        lastName: input.lastName ?? "",
        phone: input.phone,
        email: input.email ?? null,
        company: input.company ?? null,
        eventDate: input.eventDate,
        eventTime: input.eventTime ?? null,
        guests: input.guests,
        type: input.type,
        notes: input.notes ?? null,
        actor: user.email,
      })),
    };
  }),
);
