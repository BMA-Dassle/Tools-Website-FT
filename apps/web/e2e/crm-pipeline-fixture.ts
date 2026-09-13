import { neon } from "@neondatabase/serverless";

/**
 * A BOARD WITH CARDS ON IT, for the length of one Playwright run.
 *
 * `crm_leads` is empty in every environment the CRM has been built in so far,
 * so a pipeline screenshot taken as-is proves only that the screen mounts. It
 * says nothing about the thing B4 is: columns, cards, swimlanes, the late dot,
 * the column sums. So the suite puts a handful of leads on the board, shoots
 * it, and takes them off again.
 *
 * SELF-CLEANING, AND PRECISELY SO. Every row it writes carries
 * `capture_payload->>'e2e' = 'crm-pipeline'`, and that marker — not a time
 * window, not an id range — is what the teardown deletes by. A run that dies
 * half way leaves rows that the NEXT run's `clearPipelineFixture()` removes
 * before it seeds, so the marker is the whole lifecycle rather than a hope
 * that `afterAll` got to run.
 *
 * Raw SQL, not the leads service: `createLead()` de-duplicates, assigns and
 * can mint, and none of that belongs in a screenshot fixture. These rows are
 * set dressing, and they are shaped by hand so the board shows every case it
 * has to show.
 */

const MARKER = "crm-pipeline";

export interface FixtureLead {
  publicId: string;
  statusId: string;
}

function db(databaseUrl: string) {
  if (!databaseUrl) throw new Error("crm-pipeline fixture: DATABASE_URL is empty");
  return neon(databaseUrl);
}

/** Delete every row this fixture has ever written. Safe to call twice. */
export async function clearPipelineFixture(databaseUrl: string): Promise<void> {
  const sql = db(databaseUrl);
  await sql`
    DELETE FROM crm_activities
     WHERE lead_id IN (SELECT id FROM crm_leads WHERE capture_payload->>'e2e' = ${MARKER})
  `;
  await sql`DELETE FROM crm_leads WHERE capture_payload->>'e2e' = ${MARKER}`;
  await sql`DELETE FROM crm_contacts WHERE meta->>'e2e' = ${MARKER}`;
}

/**
 * The cards. One per on-board column so nothing renders as an empty board, an
 * OVERDUE one so the swimlane's late dot has something to be about, and a won
 * and a lost one so the two synthetic buckets are not empty either.
 *
 * `guests` and `value_cents` are ordinary numbers, not BMI ids — nothing here
 * goes near the 17-digit precision rule.
 */
const CARDS: ReadonlyArray<{
  status: string;
  repSlug: string | null;
  valueCents: number;
  guests: number;
  centre: "HPFM" | "FT" | "HPN";
  dueMinutes: number | null;
  label: string;
  first: string;
  last: string;
}> = [
  {
    status: "assigned",
    repSlug: "kelsea",
    valueCents: 84_000,
    guests: 24,
    centre: "HPFM",
    dueMinutes: 120,
    label: "First call",
    first: "Ada",
    last: "Hollister",
  },
  {
    status: "contacted",
    repSlug: "kelsea",
    valueCents: 132_500,
    guests: 40,
    centre: "FT",
    dueMinutes: -90,
    label: "Follow up",
    first: "Ben",
    last: "Okafor",
  },
  {
    status: "waiting",
    repSlug: "lori",
    valueCents: 61_000,
    guests: 18,
    centre: "HPN",
    dueMinutes: 1440,
    label: "Chase the date",
    first: "Carla",
    last: "Reyes",
  },
  {
    status: "quote",
    repSlug: "lori",
    valueCents: 245_000,
    guests: 60,
    centre: "HPFM",
    dueMinutes: 300,
    label: "Quote sent — chase",
    first: "Devon",
    last: "Marsh",
  },
  {
    status: "quote",
    repSlug: "stephanie",
    valueCents: 98_000,
    guests: 30,
    centre: "FT",
    dueMinutes: -30,
    label: "Second quote",
    first: "Elena",
    last: "Fitzgerald",
  },
  {
    status: "contract",
    repSlug: "stephanie",
    valueCents: 310_000,
    guests: 75,
    centre: "HPN",
    dueMinutes: 2880,
    label: "Chase signature",
    first: "Femi",
    last: "Adeyemi",
  },
  {
    status: "confirmed",
    repSlug: "kelsea",
    valueCents: 188_000,
    guests: 48,
    centre: "HPFM",
    dueMinutes: null,
    label: "",
    first: "Grace",
    last: "Nakamura",
  },
  {
    status: "lost",
    repSlug: "lori",
    valueCents: 54_000,
    guests: 16,
    centre: "FT",
    dueMinutes: null,
    label: "",
    first: "Hugo",
    last: "Petrov",
  },
];

/**
 * Seed the board and return what landed. Clears first, so a re-run is idempotent.
 * Reps are looked up by slug; a missing rep leaves that card unassigned rather
 * than failing the run, because the board must render either way.
 */
export async function seedPipelineFixture(databaseUrl: string): Promise<FixtureLead[]> {
  await clearPipelineFixture(databaseUrl);
  const sql = db(databaseUrl);

  const repRows = (await sql`
    SELECT id::text AS id, slug FROM crm_reps
  `) as { id: string; slug: string }[];
  const repBySlug = new Map(repRows.map((r) => [r.slug, r.id]));

  const out: FixtureLead[] = [];
  for (const [i, card] of CARDS.entries()) {
    const contact = (await sql`
      INSERT INTO crm_contacts (first_name, last_name, phone_e164, email, email_key, prefers, meta)
      VALUES (${card.first}, ${card.last}, ${"+1239555" + String(1000 + i)},
              ${`${card.first.toLowerCase()}.${card.last.toLowerCase()}@example.com`},
              ${`${card.first.toLowerCase()}.${card.last.toLowerCase()}@example.com`},
              'text', ${JSON.stringify({ e2e: MARKER })}::jsonb)
      RETURNING id::text AS id
    `) as { id: string }[];

    const repId = card.repSlug ? (repBySlug.get(card.repSlug) ?? null) : null;
    // 6 to 13 weeks out, so "days out" on a card is a plausible number.
    const eventDate = new Date(Date.now() + (42 + i * 7) * 86_400_000).toISOString().slice(0, 10);
    const due =
      card.dueMinutes === null
        ? null
        : new Date(Date.now() + card.dueMinutes * 60_000).toISOString();
    // Every card but the untouched "Assigned" one has been spoken to already,
    // so the response badge on the card has something to say.
    const firstTouch =
      card.status === "assigned" ? null : new Date(Date.now() - 86_400_000).toISOString();

    const lead = (await sql`
      WITH n AS (SELECT nextval(pg_get_serial_sequence('crm_leads', 'id')) AS id)
      INSERT INTO crm_leads (id, public_id, contact_id, centre, event_date, event_time, guests,
                             event_type, source, is_prospect, status_id, assigned_rep_id,
                             assigned_at, first_touch_at, next_action_kind, next_action_due,
                             next_action_label, value_cents, capture_payload, created_by)
      SELECT n.id, 'L-' || n.id::text, ${contact[0]!.id}::bigint, ${card.centre},
             ${eventDate}::date, '18:00'::time, ${card.guests}, 'corporate', 'web', FALSE,
             ${card.status}, ${repId}::bigint,
             NOW() - INTERVAL '2 days', ${firstTouch}::timestamptz,
             ${due === null ? null : "call"}, ${due}::timestamptz,
             ${card.label || null}, ${card.valueCents},
             ${JSON.stringify({ e2e: MARKER })}::jsonb, 'e2e'
        FROM n
      RETURNING public_id
    `) as { public_id: string }[];

    out.push({ publicId: lead[0]!.public_id, statusId: card.status });
  }

  await seedHistory(databaseUrl, timelineLeadOf(out));
  return out;
}

/**
 * The lead the deal-drawer test opens, chosen the same way the spec chooses it
 * — the first Quote — so the history below lands on the deal that is shot.
 */
export function timelineLeadOf(leads: readonly FixtureLead[]): string | null {
  return (leads.find((l) => l.statusId === "quote") ?? leads[0])?.publicId ?? null;
}

/**
 * A LEAD WITH A PAST, so the deal drawer's timeline is a timeline and not an
 * empty state. Without this the Overview screenshot shows "Nothing logged yet",
 * which is a true statement about no data rather than a picture of the feature.
 *
 * The call is TODAY and outbound, so the header's touch tally has something to
 * count — and counting it is the rule B4 made executable (a touch counts once
 * per lead per channel per Eastern day).
 */
async function seedHistory(databaseUrl: string, publicId: string | null): Promise<void> {
  if (!publicId) return;
  const sql = db(databaseUrl);
  const rows = (await sql`
    SELECT id::text AS id, contact_id::text AS contact_id, assigned_rep_id::text AS rep_id
      FROM crm_leads WHERE public_id = ${publicId}
  `) as { id: string; contact_id: string | null; rep_id: string | null }[];
  const lead = rows[0];
  if (!lead) return;

  const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
  const entries: ReadonlyArray<{
    kind: string;
    direction: string | null;
    at: string;
    body: string | null;
    outcome: string | null;
    seconds: number | null;
  }> = [
    {
      kind: "system",
      direction: null,
      at: ago(2880),
      body: "Assigned by the rules — on shift, centre match, fewest open leads",
      outcome: null,
      seconds: null,
    },
    {
      kind: "call",
      direction: "out",
      at: ago(1500),
      body: "Left a voicemail about the November date",
      outcome: "Voicemail",
      seconds: 42,
    },
    {
      kind: "note",
      direction: null,
      at: ago(1440),
      body: "Wants the private room and a cash bar. Budget is firm at $40 a head.",
      outcome: null,
      seconds: null,
    },
    {
      kind: "status",
      direction: null,
      at: ago(300),
      body: "Contacted → Quote sent by eric@headpinz.com",
      outcome: null,
      seconds: null,
    },
    {
      kind: "call",
      direction: "out",
      at: ago(90),
      body: "Walked through the quote; sending the contract tomorrow",
      outcome: "Reached",
      seconds: 415,
    },
  ];

  for (const e of entries) {
    await sql`
      INSERT INTO crm_activities (lead_id, contact_id, rep_id, actor_email, kind, direction,
                                  occurred_at, duration_seconds, outcome, body, meta)
      VALUES (${lead.id}::bigint, ${lead.contact_id}::bigint, ${lead.rep_id}::bigint,
              'eric@headpinz.com', ${e.kind}, ${e.direction}, ${e.at}::timestamptz,
              ${e.seconds}, ${e.outcome}, ${e.body}, ${JSON.stringify({ e2e: MARKER })}::jsonb)
    `;
  }
}
