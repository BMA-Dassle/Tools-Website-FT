import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { EventDetailQuerySchema, ProjectIdSchema, eventDetail } from "~/features/crm/events";

/**
 * GET /api/admin/crm/events/<projectId>?centre=HPFM → `{ok, event}`
 *
 * The Event tab's read for a BMI project that has NO CRM lead yet — the legacy
 * bookings the Events board renders read-only. `/leads/[id]/event` is the same
 * service reached through a lead.
 *
 * `projectId` is a 17-digit STRING from the path and stays one: zod checks it
 * is digits, and nothing here ever calls `Number()` on it (R1).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(EventDetailQuerySchema, async ({ input, params }) => {
  const raw = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const parsed = ProjectIdSchema.safeParse(raw ?? "");
  if (!parsed.success) throw new CrmHttpError(404, "project_not_found");
  return { event: await eventDetail(input.centre, parsed.data) };
});
