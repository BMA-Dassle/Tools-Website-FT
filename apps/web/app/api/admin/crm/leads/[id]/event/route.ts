import { EmptySchema } from "~/features/crm/leads";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { eventDetail, leadEventTarget, withEventsErrors } from "~/features/crm/events";

/**
 * GET /api/admin/crm/leads/[id]/event → `{ok, event}`
 *
 * The deal's Event tab: the BMI project behind the lead — schedule, products,
 * people, waivers, food out and the contract row — through
 * `getReservationDetail`, the same read the v2 Daily Events detail page makes.
 * Read-only.
 *
 * A lead that was never minted answers 409 `no_bmi_project`; the tab shows
 * "Create it in BMI first" instead of an empty table.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!raw) throw new CrmHttpError(404, "lead_not_found");
  return raw;
}

export const GET = withCrmRoute(EmptySchema, async ({ params }) =>
  withEventsErrors(async () => {
    const target = await leadEventTarget(idFrom(params));
    return { event: await eventDetail(target.centre, target.projectId) };
  }),
);
