import { isDbConfigured, sql } from "@ft/db";
import type { CentreCode } from "../../core/types";

/**
 * `crm_daily_notes` — the owner's pre-shift note on My Day.
 *
 * Owner, 2026-09-14: "Would be cool to have a little note for the day from me,
 * something like a pre shift that appears on their 'my day'."
 *
 * A PRE-SHIFT, NOT A NOTICEBOARD. The note belongs to ONE DATE and is gone the
 * next morning. That is the whole character of the thing: a pre-shift is what
 * somebody says at the start of a shift, and a message that lingers for a week
 * is an announcement nobody reads. Keeping the date on the row (rather than
 * an "active" flag somebody has to clear) means it expires itself.
 *
 * AUDIENCE, narrowing: a note with no centre and no rep is for everyone; one
 * with a centre is for that building; one with a rep is for that person. They
 * are not exclusive — a rep at Fort Myers on a day with a company-wide note AND
 * a Fort Myers note sees both, most specific first, because both were written
 * on purpose.
 *
 * DISMISSAL IS PER-REP AND DOES NOT DELETE. `crm_daily_note_reads` records who
 * has seen what, so the note stops nagging the person who read it while
 * remaining on the record — a director asking "did the team see Friday's note"
 * has an answer, which is most of why the owner wants it.
 */

let schemaReady: Promise<void> | null = null;

export function ensureDailyNotesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_daily_notes (
        id BIGSERIAL PRIMARY KEY,
        /* The ET calendar day this note is FOR — not when it was written. */
        note_date DATE NOT NULL,
        /* NULL = every centre. */
        centre TEXT,
        /* NULL = every rep at that centre. */
        rep_id BIGINT REFERENCES crm_reps(id),
        body TEXT NOT NULL,
        author_email TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    /* One note per (day, audience): writing a second one for the same audience
       EDITS it rather than stacking two notes nobody asked for. A partial
       unique index, because NULL never equals NULL in Postgres and a plain
       UNIQUE would happily allow five company-wide notes on one day. */
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_daily_notes_all_uniq
        ON crm_daily_notes (note_date)
       WHERE centre IS NULL AND rep_id IS NULL
    `;
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_daily_notes_centre_uniq
        ON crm_daily_notes (note_date, centre)
       WHERE centre IS NOT NULL AND rep_id IS NULL
    `;
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_daily_notes_rep_uniq
        ON crm_daily_notes (note_date, rep_id)
       WHERE rep_id IS NOT NULL
    `;
    await q`
      CREATE TABLE IF NOT EXISTS crm_daily_note_reads (
        note_id BIGINT NOT NULL REFERENCES crm_daily_notes(id) ON DELETE CASCADE,
        rep_id BIGINT NOT NULL REFERENCES crm_reps(id),
        read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (note_id, rep_id)
      )
    `;
  })();
  return schemaReady;
}

export interface DailyNote {
  id: string;
  date: string;
  centre: CentreCode | null;
  repId: string | null;
  body: string;
  authorEmail: string;
  createdAt: string;
  /** Has the rep asking dismissed it? */
  read: boolean;
  /** How many reps have — the director's "did they see it". */
  readCount: number;
}

interface NoteRowRaw {
  id: string;
  note_date: string;
  centre: string | null;
  rep_id: string | null;
  body: string;
  author_email: string;
  created_at: string;
  read_at: string | null;
  read_count: number;
}

function mapNote(r: NoteRowRaw): DailyNote {
  return {
    id: String(r.id),
    date: r.note_date,
    centre: (r.centre as CentreCode | null) ?? null,
    repId: r.rep_id ? String(r.rep_id) : null,
    body: r.body,
    authorEmail: r.author_email,
    createdAt: r.created_at,
    read: r.read_at !== null,
    readCount: Number(r.read_count) || 0,
  };
}

/**
 * The notes one rep should see today, most specific first.
 *
 * `repId` may be null for somebody with no rep row (a director browsing): they
 * get the company-wide and centre notes, and nothing addressed to a person.
 */
export async function listDailyNotesFor(input: {
  date: string;
  repId: string | null;
  centres: readonly CentreCode[];
}): Promise<DailyNote[]> {
  if (!isDbConfigured()) return [];
  await ensureDailyNotesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT n.id::text AS id, n.note_date::text AS note_date, n.centre, n.rep_id::text AS rep_id,
            n.body, n.author_email, n.created_at::text AS created_at,
            r.read_at::text AS read_at,
            (SELECT COUNT(*) FROM crm_daily_note_reads x WHERE x.note_id = n.id)::int AS read_count
       FROM crm_daily_notes n
       LEFT JOIN crm_daily_note_reads r
              ON r.note_id = n.id AND r.rep_id = $2::bigint
      WHERE n.note_date = $1::date
        AND (
          (n.centre IS NULL AND n.rep_id IS NULL)
          OR (n.rep_id IS NOT NULL AND n.rep_id = $2::bigint)
          OR (n.centre IS NOT NULL AND n.rep_id IS NULL AND n.centre = ANY($3::text[]))
        )
      -- Most specific first: a note written TO somebody outranks one written to
      -- their building, which outranks one written to everybody.
      ORDER BY (n.rep_id IS NOT NULL) DESC, (n.centre IS NOT NULL) DESC, n.created_at DESC`,
    [input.date, input.repId, [...input.centres]],
  )) as NoteRowRaw[];
  return rows.map(mapNote);
}

/** Every note for a date, whoever it is addressed to — the director's view. */
export async function listDailyNotesOn(date: string): Promise<DailyNote[]> {
  if (!isDbConfigured()) return [];
  await ensureDailyNotesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT n.id::text AS id, n.note_date::text AS note_date, n.centre, n.rep_id::text AS rep_id,
            n.body, n.author_email, n.created_at::text AS created_at,
            NULL::text AS read_at,
            (SELECT COUNT(*) FROM crm_daily_note_reads x WHERE x.note_id = n.id)::int AS read_count
       FROM crm_daily_notes n
      WHERE n.note_date = $1::date
      ORDER BY (n.rep_id IS NOT NULL) DESC, (n.centre IS NOT NULL) DESC, n.created_at DESC`,
    [date],
  )) as NoteRowRaw[];
  return rows.map(mapNote);
}

/** Write (or rewrite) the note for one day and audience. */
export async function upsertDailyNote(input: {
  date: string;
  centre: CentreCode | null;
  repId: string | null;
  body: string;
  authorEmail: string;
}): Promise<DailyNote | null> {
  if (!isDbConfigured()) return null;
  await ensureDailyNotesSchema();
  const q = sql();
  // Three partial unique indexes means three ON CONFLICT targets, so the
  // audience decides which one to name. A plain `ON CONFLICT` cannot infer a
  // partial index without its predicate.
  const conflict =
    input.repId !== null
      ? "(note_date, rep_id) WHERE rep_id IS NOT NULL"
      : input.centre !== null
        ? "(note_date, centre) WHERE centre IS NOT NULL AND rep_id IS NULL"
        : "(note_date) WHERE centre IS NULL AND rep_id IS NULL";
  const rows = (await q.query(
    `INSERT INTO crm_daily_notes (note_date, centre, rep_id, body, author_email)
     VALUES ($1::date, $2, $3::bigint, $4, $5)
     ON CONFLICT ${conflict}
     DO UPDATE SET body = EXCLUDED.body, author_email = EXCLUDED.author_email, updated_at = NOW()
     RETURNING id::text AS id, note_date::text AS note_date, centre, rep_id::text AS rep_id,
               body, author_email, created_at::text AS created_at,
               NULL::text AS read_at, 0 AS read_count`,
    [input.date, input.centre, input.repId, input.body, input.authorEmail],
  )) as NoteRowRaw[];
  return rows[0] ? mapNote(rows[0]) : null;
}

export async function deleteDailyNote(id: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureDailyNotesSchema();
  const q = sql();
  await q.query(`DELETE FROM crm_daily_notes WHERE id = $1::bigint`, [id]);
}

/** "I have read it" — per rep, idempotent, and never deletes the note. */
export async function markDailyNoteRead(noteId: string, repId: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureDailyNotesSchema();
  const q = sql();
  await q.query(
    `INSERT INTO crm_daily_note_reads (note_id, rep_id)
     VALUES ($1::bigint, $2::bigint)
     ON CONFLICT (note_id, rep_id) DO NOTHING`,
    [noteId, repId],
  );
}
