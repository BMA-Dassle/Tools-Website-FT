import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  WaiversSchema,
  leadEventTarget,
  sendWaiverLinks,
  withEventsErrors,
} from "~/features/crm/events";

/**
 * POST /api/admin/crm/leads/[id]/waivers → `{ok, sent, organizerUrl, signUrl, reason}`
 *
 * THE EXISTING RAIL, not a new one: `notifyWaiverReminder(quote)` from
 * `lib/group-function-notify.ts` — the same email + text the 7-day and 2-day
 * crons send, with the organizer link for the booker and a sign-only link to
 * forward. The CRM has not grown a second sender and never calls `voxSend`
 * itself (R8: CRM texting is the messaging PR's rail).
 *
 * Both links come back whatever happens, minted through
 * `waiverLinksForReservation`, so a legacy event with no contract row still
 * gives the desk something to copy — `reason` says why nothing was sent
 * (`no_contract`, `no_waiver_products`, `no_links`).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!raw) throw new CrmHttpError(404, "lead_not_found");
  return raw;
}

export const POST = withCrmRoute(WaiversSchema, async ({ params, req, user }) =>
  withEventsErrors(async () => {
    const t = await leadEventTarget(idFrom(params));
    return {
      ...(await sendWaiverLinks({
        centre: t.centre,
        projectId: t.projectId,
        leadId: t.lead.id,
        date: t.date,
        actor: user.email,
        origin: req.nextUrl.origin,
      })),
    };
  }),
);
