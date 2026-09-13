import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  CallDispositionSchema,
  CallIdSchema,
  CallNotFoundError,
  applyDisposition,
} from "~/features/crm/calls";

/**
 * POST /api/admin/crm/calls/[id]/disposition
 *   {disposition, note?} → `{ok, call, firstTouchRecorded, leadStatus}`
 *
 * "When the call ends" (`crm-shared.js:259`): the outcome and note are stored
 * on the call, a `call` activity is appended, an OUTBOUND call by the lead's
 * own assignee becomes `first_touch_at` through B3's `recordFirstTouch`, an
 * `assigned` lead moves to `contacted`, and "Reached" clears the follow-up.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCrmRoute(CallDispositionSchema, async ({ input, params, user }) => {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const parsed = CallIdSchema.safeParse(raw ?? "");
  if (!parsed.success) throw new CrmHttpError(404, "call_not_found");

  const result = await applyDisposition({
    callId: parsed.data,
    disposition: input.disposition,
    note: input.note ?? null,
    user,
  }).catch((err: unknown) => {
    // The service stays free of `next/server`; the route does the mapping.
    if (err instanceof CallNotFoundError) throw new CrmHttpError(404, err.message);
    throw err;
  });
  await writeAudit({
    entity: "call",
    entityId: result.call.id,
    action: "disposition",
    actorEmail: user.email,
    after: {
      disposition: input.disposition,
      leadId: result.call.leadId,
      firstTouchRecorded: result.firstTouchRecorded,
      leadStatus: result.leadStatus,
    },
  });
  return {
    call: result.call,
    firstTouchRecorded: result.firstTouchRecorded,
    leadStatus: result.leadStatus,
  };
});
