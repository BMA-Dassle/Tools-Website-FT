import { EmptySchema } from "~/features/crm/leads";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import {
  PublicNotesPostSchema,
  leadEventTarget,
  previewPublicNotes,
  readNotes,
  savePublicNotes,
  withEventsErrors,
} from "~/features/crm/events";

/**
 * /api/admin/crm/leads/[id]/notes/public
 *   GET  → `{ok, projectId, publicNotes, privateMemo, sections, foodOut, crmNotes, writesEnabled}`
 *   POST `{notes, preview?, clean?}` (or `?preview=1`)
 *        preview  → `{ok, original, cleaned, changed, available}` and NOTHING is written
 *        else     → `{ok, publicNotes, cleaned, verified}`
 *
 * THE AI CLEAN-UP IS THE EXISTING ONE: `cleanupNotesGrammar` from
 * `apps/web/lib/notes-grammar.ts` — the function the contract-send path runs
 * at `app/api/cron/group-quote-dispatch/route.ts:1030-1040` before it writes
 * the event name and notes back to Office. The CRM reuses it rather than
 * prompting its own model, so the text the guest sees is edited by one editor.
 *
 * The write is `updateProjectPublicNotes` (REPLACE-only, Pandora first with an
 * Office PUT fallback) and it is VERIFIED by a re-read: Pandora can answer
 * `{"success":true}` without the write landing (R5), so `verified:false` comes
 * back and the rep is told, rather than a green toast over a lost edit.
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
    const t = await leadEventTarget(idFrom(params));
    return {
      ...(await readNotes({
        centre: t.centre,
        projectId: t.projectId,
        leadId: t.lead.id,
        date: t.date,
      })),
    };
  }),
);

export const POST = withCrmRoute(PublicNotesPostSchema, async ({ input, params, req, user }) =>
  withEventsErrors(async () => {
    // `withCrmRoute` parses the BODY on a POST, so the brief's `?preview=1` is
    // read here as well as the body flag — both spellings mean "show me, do
    // not write", and neither may fall through to the Office call.
    const preview = input.preview || req.nextUrl.searchParams.get("preview") === "1";
    if (preview) return { ...(await previewPublicNotes(input.notes)) };
    const t = await leadEventTarget(idFrom(params));
    return {
      ...(await savePublicNotes({
        centre: t.centre,
        projectId: t.projectId,
        leadId: t.lead.id,
        date: t.date,
        notes: input.notes,
        clean: input.clean,
        actor: user.email,
      })),
    };
  }),
);
