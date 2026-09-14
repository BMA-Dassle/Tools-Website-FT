import { z } from "zod";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CENTRE_CODES } from "~/features/crm/core/centres";
import { todayEasternYmd } from "~/features/crm/core/dates";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { isDirector } from "~/features/crm/core/identity";
import {
  deleteDailyNote,
  listDailyNotesFor,
  listDailyNotesOn,
  markDailyNoteRead,
  upsertDailyNote,
} from "~/features/crm/leads/data/daily-notes-db";

/**
 * /api/admin/crm/daily-note — the owner's pre-shift note on My Day.
 *
 * Owner, 2026-09-14: "Would be cool to have a little note for the day from me,
 * something like a pre shift that appears on their 'my day'."
 *
 *   GET    ?date=            → the notes THIS person should see (a director
 *                              also gets every note for the day, to edit)
 *   POST   {date,centre,rep,body}   → write or rewrite one  (director)
 *   POST   {noteId, read:true}      → "I've read it"        (any rep)
 *   DELETE {noteId}                 → take it down          (director)
 *
 * A note belongs to ONE DATE and expires by being about yesterday. Dismissal
 * is per rep and never deletes: a director asking "did the team see Friday's
 * note" needs the answer to still exist.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const GetSchema = z.object({ date: Ymd.optional() });

const PostSchema = z.union([
  z.object({
    /** Acknowledge — the only thing a non-director may do here. */
    noteId: z.string().min(1),
    read: z.literal(true),
  }),
  z.object({
    date: Ymd.optional(),
    /** null / absent = every centre. */
    centre: z.enum(CENTRE_CODES).nullable().optional(),
    /** null / absent = everybody at that centre. */
    repId: z.string().min(1).nullable().optional(),
    body: z.string().trim().min(1).max(2000),
  }),
]);

export const GET = withCrmRoute(GetSchema, async ({ input, user }) => {
  const date = input.date ?? todayEasternYmd();
  const mine = await listDailyNotesFor({
    date,
    repId: user.rep?.id ?? null,
    centres: user.rep?.centres ?? [...CENTRE_CODES],
  });
  return {
    date,
    notes: mine,
    // A director also sees what everybody else was sent, so they can edit or
    // take one down without hunting for it.
    all: isDirector(user) ? await listDailyNotesOn(date) : [],
  };
});

export const POST = withCrmRoute(PostSchema, async ({ input, user }) => {
  if ("read" in input) {
    // Acknowledging is not a director action — it is the whole point for a rep.
    if (!user.rep) throw new CrmHttpError(400, "no_rep_row_to_acknowledge_as");
    await markDailyNoteRead(input.noteId, user.rep.id);
    return { ok: true as const };
  }

  if (!isDirector(user)) throw new CrmHttpError(403, "director_only");
  const date = input.date ?? todayEasternYmd();
  const note = await upsertDailyNote({
    date,
    centre: input.centre ?? null,
    repId: input.repId ?? null,
    body: input.body,
    authorEmail: user.email,
  });
  if (!note) throw new CrmHttpError(500, "note_not_saved");
  await writeAudit({
    entity: "daily_note",
    entityId: `${date}:${input.centre ?? "all"}:${input.repId ?? "all"}`,
    action: "upsert",
    actorEmail: user.email,
    after: { body: note.body },
  });
  return { date, note };
});

export const DELETE = withCrmRoute(
  z.object({ noteId: z.string().min(1) }),
  async ({ input, user }) => {
    await deleteDailyNote(input.noteId);
    await writeAudit({
      entity: "daily_note",
      entityId: input.noteId,
      action: "delete",
      actorEmail: user.email,
    });
    return { ok: true as const };
  },
  { director: true },
);
