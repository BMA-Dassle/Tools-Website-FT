import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  PrivateNoteSchema,
  appendPrivateNote,
  leadEventTarget,
  withEventsErrors,
} from "~/features/crm/events";

/**
 * POST /api/admin/crm/leads/[id]/notes/private `{note}`
 *   → `{ok, appended, privateMemo, sections}`
 *
 * APPEND-ONLY, through `appendProjectPrivateNote` — which merges into the
 * `── FastTrax Web ──` section, keeps every other writer's text (the
 * `----- Portal Staff -----` food-out line and anything staff typed in Office
 * by hand) and verifies its own write. The CRM never PUTs `projectLog`: that
 * whole-entity write belongs to `syncBmiNotes` (R6).
 *
 * R2: the note is on the deal's timeline BEFORE Office is called, so a BMI
 * outage loses the sync, never the text. `appended:false` says exactly that.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!raw) throw new CrmHttpError(404, "lead_not_found");
  return raw;
}

export const POST = withCrmRoute(PrivateNoteSchema, async ({ input, params, user }) =>
  withEventsErrors(async () => {
    const t = await leadEventTarget(idFrom(params));
    return {
      ...(await appendPrivateNote({
        centre: t.centre,
        projectId: t.projectId,
        leadId: t.lead.id,
        date: t.date,
        note: input.note,
        actor: user.email,
      })),
    };
  }),
);
