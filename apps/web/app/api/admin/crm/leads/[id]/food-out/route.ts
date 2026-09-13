import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  FoodOutSchema,
  leadEventTarget,
  saveFoodOut,
  withEventsErrors,
} from "~/features/crm/events";

/**
 * POST /api/admin/crm/leads/[id]/food-out `{foodOutTime}` → `{ok, foodOut}`
 *
 * `saveManualFoodOut` is the existing rail: it upserts the `event_metadata`
 * row as `source:'manual'` (so the AI extraction stops overwriting it) and
 * then fires `syncBmiNotes`, which rewrites the `----- Portal Staff -----`
 * slice of the private memo and preserves the FastTrax Web block. That is the
 * ONLY way the CRM touches that section — it never edits the memo itself.
 *
 * `null` clears the time.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!raw) throw new CrmHttpError(404, "lead_not_found");
  return raw;
}

export const POST = withCrmRoute(FoodOutSchema, async ({ input, params, user }) =>
  withEventsErrors(async () => {
    const t = await leadEventTarget(idFrom(params));
    const foodOut = await saveFoodOut({
      centre: t.centre,
      projectId: t.projectId,
      leadId: t.lead.id,
      date: t.date,
      foodOutTime: input.foodOutTime,
      actor: user.email,
    });
    return { foodOut };
  }),
);
