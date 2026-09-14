/**
 * ADOPT THE DEALS THAT WERE ALREADY IN FLIGHT WHEN THE CRM ARRIVED.
 *
 * The build assumed every lead would be born in the CRM: a guest fills in the
 * web form, we write `crm_leads` first and mint the Office project second. That
 * is right for everything from now on and WRONG for the day we switch over,
 * because BMI already holds live deals — an enquiry a planner logged last week,
 * a quote out for signature, a deposit requested. Owner, 2026-09-13, looking at
 * an empty Pipeline: "We have a leads status in bmi that should have been pulled
 * in." They were right. Without this the board reads zero on day one however
 * much history the mirror carries, and a planner's real work is invisible.
 *
 * WHAT IT DOES NOT DO. It never writes to Office — it reads the mirror the
 * backfill already populated and writes only our own rows. It never touches a
 * project that is won (Confirmation and its variants), lost (Cancellation), or
 * an online booking (`kind_id = '-10'`): those belong in History, not in a
 * planner's queue. It is idempotent on `bmi_project_id`, so running it twice
 * adopts nothing the second time.
 *
 * FUTURE EVENTS ONLY. Owner caught this before a single row was written: "These
 * are all for future events?" They were not. Of the 230 the first pass would
 * have taken, 145 were in the PAST — back to November 2023, with 36 from 2023
 * and 73 from 2024 — dead quotes nobody ever closed out in Office. Adopting
 * those would have put three years of junk on a planner's board on day one,
 * which is the same mistake the Contracts "needs attention" rule was making an
 * hour earlier. A past event sitting in an open state is an unfinished tidy-up
 * in BMI, not a live deal; it stays in History where it belongs. That leaves
 * 85 real ones.
 *
 * ASSIGNMENT is taken from BMI's own `responsible`, not from our rules engine.
 * These deals already have an owner and re-running assignment would hand one
 * planner's live work to another. The Office user id is matched first and the
 * Office display name second, because `crm_reps.bmi_user_id` holds the FORT
 * MYERS id only and the same person has a different id at Naples — so a Naples
 * project would match nobody on id alone.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CentreCode } from "../../core/types";

/**
 * BMI state → our status, for the states a deal can sit in while it is still
 * being SOLD. Anything absent is deliberately not adopted.
 *
 * Read off Office metadata for both tenants on 2026-09-13. The two centres name
 * the same steps with different ids, which is why this is keyed per tenant. The
 * "deposit requested" family maps to `contract` rather than `deposit`: the money
 * has been ASKED for, not received, so the deal is still open work.
 */
export const ADOPTABLE_STATES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  headpinzftmyers: {
    "3891928": "new", // New Lead
    "7845185": "contacted", // Contacted
    "-2": "quote", // Pending Quote
    "49130082": "contract", // Send Contract
    "48952154": "contract", // Pending Signed Contract
    "3272786": "contract", // Deposit Requested (HPFM)
    "15737202": "contract", // Deposit Requested (FT)
    "48952156": "contract", // New Deposit Requested - FT
  },
  headpinznaples: {
    "1565479": "new", // New Lead
    "3703830": "contacted", // Contacted
    "-2": "quote", // Pending Quote
    "8020645": "contract", // Send Contract
    "8007473": "contract", // Pending Signed Contract
    "1190814": "contract", // Deposit Requested
  },
};

/**
 * WON states, adopted too — into the board's Booked column.
 *
 * Owner: "I see contracts that ae not on the pipeline why?" Because only deals
 * still being SOLD were adopted. Of 177 open contracts just 71 had a lead, so
 * 106 were invisible on the board and Booked read zero. A signed, deposit-paid
 * event is not sales work any more, but it is absolutely something a planner
 * expects to see on their pipeline — the prototype gives it a column.
 *
 * Confirmation and its variants are the booked state; Deposit Paid is its own.
 * Cancellation stays out: a dead event belongs in History, not on a board.
 * Still future-only, like everything else here.
 */
export const WON_STATES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  headpinzftmyers: {
    "-3": "confirmed", // Confirmation
    "3274635": "confirmed", // Confirmation + Waiver
    "55397028": "confirmed", // Confirmation - Express Lane
    "55466363": "confirmed", // Confirmation - VIP
    "-106": "deposit", // Deposit Paid
  },
  headpinznaples: {
    "-3": "confirmed", // Confirmation
    "1191926": "confirmed", // Confirmation + Waiver
    "8489113": "confirmed", // Confirmation - Kiosk
    "-106": "deposit", // Deposite Paid (Office's spelling)
  },
};

/** Every state we will adopt, open and won, flattened per tenant. */
export const ALL_ADOPTABLE: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.fromEntries(
    [...new Set([...Object.keys(ADOPTABLE_STATES), ...Object.keys(WON_STATES)])].map((ck) => [
      ck,
      { ...(ADOPTABLE_STATES[ck] ?? {}), ...(WON_STATES[ck] ?? {}) },
    ]),
  );

/**
 * OFFICE USER IDS ARE PER TENANT, and `crm_reps.bmi_user_id` holds only one.
 *
 * The same person is a different id at each centre. Probed from live Office
 * metadata and the mirror, Fort Myers first, Naples second:
 *
 *   eric 75262 / 25228 · lori 465247 / 41096 · stephanie 465242 / 1559644
 *   jacob 7251049 / 3690605 · kelsea 28267036 / 6338800 · gs 30080112 / 6400642
 *
 * The roster column carries the Fort Myers value, so every NAPLES project
 * matched nobody on id. That is why the owner saw a BMI "New Lead" with a real
 * owner arrive here with none, and why the Assigned column was empty: all three
 * were Naples enquiries owned by Guest Services under Naples id 6400642, which
 * the roster has never heard of. Office also calls that bucket "CallCenter"
 * rather than "Guest Services", so the name fallback missed it too.
 *
 * A stop-gap in the shape the brief asks for (`crm_reps.bmi_user_ids` as JSONB
 * plus `bmiUserIdFor(rep, clientKey)`). Until that column exists the pairs live
 * here, beside the failure that found them.
 */
export const OFFICE_ID_ALIASES: Readonly<Record<string, string>> = {
  "25228": "eric",
  "41096": "lori",
  "1559644": "stephanie",
  "3690605": "jacob",
  "6338800": "kelsea",
  "6400642": "gs",
};

/** Office display names that are not the roster's display name. */
export const OFFICE_NAME_ALIASES: Readonly<Record<string, string>> = {
  callcenter: "gs",
  "call center": "gs",
  "guest services": "gs",
};

/** Office location id → the centre a planner would name. */
export function centreOfLocation(locationId: number | null): CentreCode | null {
  if (locationId === 332160) return "HPFM";
  if (locationId === 467486) return "FT";
  if (locationId === 332145) return "HPN";
  return null;
}

export interface AdoptResult {
  scanned: number;
  adopted: number;
  skippedAlreadyLinked: number;
  skippedNoCentre: number;
  skippedNoDate: number;
  unmatchedReps: string[];
  byStatus: Record<string, number>;
  /** How many landed on a planner's board vs sat unassigned for a director. */
  assigned: number;
  unassigned: number;
}

interface MirrorCandidate {
  project_id: string;
  client_key: string;
  location_id: number | null;
  number: string | null;
  name: string | null;
  state_id: string | null;
  state_name: string | null;
  responsible_user_id: string | null;
  responsible_name: string | null;
  event_date: string | null;
  event_start: string | null;
  persons: number | null;
  total_value_cents: string | null;
  person_id: string | null;
  account_id: string | null;
  contact_id: string | null;
}

/**
 * Re-resolve the owner of leads that were adopted before the per-tenant ids
 * above were known, and that therefore landed with nobody on them.
 *
 * Adoption is idempotent on `bmi_project_id`, which is the right default and
 * also means a matcher fix does NOT reach rows already written — they are
 * skipped, not revisited. Without this the three Naples enquiries the owner
 * spotted would have stayed ownerless for ever, and the fix above would only
 * have helped deals adopted in the future.
 *
 * Only ever FILLS a blank owner. It will not move a lead that already has one,
 * whether a director assigned it by hand or adoption got it right first time.
 *
 * NOT LIMITED TO ADOPTED ROWS. It used to filter on `created_by = 'crm-adopt'`,
 * which missed the ones the owner then found sitting in the queue: leads made
 * by CLICKING an event before that path learned to take the planner from the
 * project. Any lead with a project and no owner is the same problem whatever
 * made it, and the join to `crm_bmi_projects` already means a lead with no
 * project cannot be touched.
 */
export async function repairAdoptedAssignments({ dryRun = false } = {}): Promise<{
  candidates: number;
  repaired: number;
  stillUnmatched: string[];
}> {
  const out = { candidates: 0, repaired: 0, stillUnmatched: [] as string[] };
  if (!isDbConfigured()) return out;
  const q = sql();

  const reps = (await q`
    SELECT id::text AS id, slug, bmi_user_id, lower(bmi_username) AS uname, lower(first_name) AS fname
      FROM crm_reps WHERE active IS TRUE
  `) as {
    id: string;
    slug: string;
    bmi_user_id: string | null;
    uname: string | null;
    fname: string | null;
  }[];
  const byOfficeId = new Map(reps.filter((r) => r.bmi_user_id).map((r) => [r.bmi_user_id!, r.id]));
  const bySlug = new Map(reps.map((r) => [r.slug, r.id]));
  const byName = new Map<string, string>();
  for (const r of reps) {
    if (r.uname) byName.set(r.uname, r.id);
    if (r.fname) byName.set(r.fname, r.id);
  }

  const rows = (await q`
    SELECT l.id::text AS lead_id, p.responsible_user_id, p.responsible_name
      FROM crm_leads l
      JOIN crm_bmi_projects p ON p.project_id = l.bmi_project_id
     WHERE l.assigned_rep_id IS NULL
       AND l.archived_at IS NULL
  `) as { lead_id: string; responsible_user_id: string | null; responsible_name: string | null }[];

  const unmatched = new Set<string>();
  for (const r of rows) {
    out.candidates += 1;
    const alias =
      (r.responsible_user_id ? OFFICE_ID_ALIASES[r.responsible_user_id] : undefined) ??
      (r.responsible_name
        ? OFFICE_NAME_ALIASES[r.responsible_name.trim().toLowerCase()]
        : undefined);
    const repId =
      (r.responsible_user_id ? byOfficeId.get(r.responsible_user_id) : undefined) ??
      (alias ? bySlug.get(alias) : undefined) ??
      (r.responsible_name ? byName.get(r.responsible_name.toLowerCase()) : undefined) ??
      null;
    if (!repId) {
      if (r.responsible_name) unmatched.add(r.responsible_name);
      continue;
    }
    if (!dryRun) {
      // `assigned` rather than `new`: BMI says a planner owns it, so it is not
      // waiting for a first decision.
      await q`
        UPDATE crm_leads
           SET assigned_rep_id = ${repId}::bigint,
               assigned_at = COALESCE(assigned_at, now()),
               status_id = CASE WHEN status_id = 'new' THEN 'assigned' ELSE status_id END,
               updated_at = now()
         WHERE id = ${r.lead_id}::bigint AND assigned_rep_id IS NULL`;
    }
    out.repaired += 1;
  }
  out.stillUnmatched = [...unmatched].sort();
  return out;
}

/**
 * @param dryRun report what WOULD be adopted without writing a row. The owner
 *   sees the count and the status split before anything lands in a planner's
 *   queue, because a bad run would put someone else's deals on their board.
 */
export async function adoptOpenBmiDeals({ dryRun = false } = {}): Promise<AdoptResult> {
  const out: AdoptResult = {
    scanned: 0,
    adopted: 0,
    skippedAlreadyLinked: 0,
    skippedNoCentre: 0,
    skippedNoDate: 0,
    unmatchedReps: [],
    byStatus: {},
    assigned: 0,
    unassigned: 0,
  };
  if (!isDbConfigured()) return out;
  const q = sql();

  // Office id AND display name, so a Naples project whose id does not match can
  // still find its planner by the name Office shows.
  const reps = (await q`
    SELECT id::text AS id, slug, role, bmi_user_id, lower(bmi_username) AS uname,
           lower(display_name) AS dname, lower(first_name) AS fname
      FROM crm_reps
     WHERE active IS TRUE
  `) as {
    id: string;
    slug: string;
    role: string;
    bmi_user_id: string | null;
    uname: string | null;
    dname: string | null;
    fname: string | null;
  }[];
  const byOfficeId = new Map(reps.filter((r) => r.bmi_user_id).map((r) => [r.bmi_user_id!, r.id]));
  const bySlug = new Map(reps.map((r) => [r.slug, r.id]));

  // NAME MATCHING IS THREE-TIERED AND FIRST NAMES ARE THE TIER THAT MATTERS.
  // Office's `responsible` is frequently just "Kelsea" or "Lori" — the full
  // "Kelsea Kosco" that `bmi_username` holds is the exception, not the rule, so
  // a full-name-only match left both of them unassigned on the first dry run.
  // A first name is only accepted when exactly ONE active rep answers to it, so
  // two Kelseas would fall through to unmatched rather than pick one at random.
  const byName = new Map<string, string>();
  for (const r of reps) {
    if (r.uname) byName.set(r.uname, r.id);
    if (r.dname) byName.set(r.dname, r.id);
  }
  const firstNameCounts = new Map<string, number>();
  for (const r of reps) {
    if (r.fname) firstNameCounts.set(r.fname, (firstNameCounts.get(r.fname) ?? 0) + 1);
  }
  for (const r of reps) {
    if (r.fname && firstNameCounts.get(r.fname) === 1 && !byName.has(r.fname)) {
      byName.set(r.fname, r.id);
    }
  }

  const states = Object.entries(ALL_ADOPTABLE).flatMap(([ck, m]) =>
    Object.keys(m).map((s) => `${ck}|${s}`),
  );

  const rows = (await q`
    SELECT p.project_id, p.client_key, p.location_id, p.number, p.name, p.state_id, p.state_name,
           p.responsible_user_id, p.responsible_name, p.event_date::text AS event_date,
           -- event_start is a full timestamp; crm_leads.event_time is a TIME, so
           -- the cast happens HERE rather than by slicing the text (a slice took
           -- "2027-08-" off "2027-08-24 14:00:00" and Postgres rejected it).
           to_char(p.event_start, 'HH24:MI:SS') AS event_start,
           p.persons, p.total_value_cents::text AS total_value_cents,
           p.person_id, p.account_id::text AS account_id, p.contact_id::text AS contact_id
      FROM crm_bmi_projects p
     WHERE p.kind_id IS DISTINCT FROM '-10'
       AND (p.client_key || '|' || COALESCE(p.state_id, '')) = ANY(${states}::text[])
       AND p.event_date >= CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.bmi_project_id = p.project_id)
     ORDER BY p.event_date DESC NULLS LAST
  `) as MirrorCandidate[];

  const alreadyLinked = (await q`
    SELECT COUNT(*)::int AS n
      FROM crm_bmi_projects p
     WHERE p.kind_id IS DISTINCT FROM '-10'
       AND (p.client_key || '|' || COALESCE(p.state_id, '')) = ANY(${states}::text[])
       AND EXISTS (SELECT 1 FROM crm_leads l WHERE l.bmi_project_id = p.project_id)
  `) as { n: number }[];
  out.skippedAlreadyLinked = alreadyLinked[0]?.n ?? 0;

  const unmatched = new Set<string>();

  for (const r of rows) {
    out.scanned += 1;
    const centre = centreOfLocation(r.location_id);
    if (!centre) {
      out.skippedNoCentre += 1;
      continue;
    }
    // `event_date` is NOT NULL on crm_leads and a deal with no date cannot be
    // worked or scheduled, so it stays in History rather than being given a
    // made-up one.
    if (!r.event_date) {
      out.skippedNoDate += 1;
      continue;
    }

    const statusId = ALL_ADOPTABLE[r.client_key]?.[String(r.state_id)] ?? "new";
    const aliasSlug =
      (r.responsible_user_id ? OFFICE_ID_ALIASES[r.responsible_user_id] : undefined) ??
      (r.responsible_name
        ? OFFICE_NAME_ALIASES[r.responsible_name.trim().toLowerCase()]
        : undefined);
    const repId =
      (r.responsible_user_id ? byOfficeId.get(r.responsible_user_id) : undefined) ??
      (aliasSlug ? bySlug.get(aliasSlug) : undefined) ??
      (r.responsible_name ? byName.get(r.responsible_name.toLowerCase()) : undefined) ??
      null;
    if (!repId && r.responsible_name) unmatched.add(r.responsible_name);

    // A deal BMI has already assigned is `assigned`, not `new` — the planner is
    // working it, and leaving it `new` would put it back in the unassigned
    // queue as though nobody had touched it.
    const effectiveStatus = statusId === "new" && repId ? "assigned" : statusId;
    // A booked event keeps its won status; only a brand-new enquiry gets
    // promoted to `assigned` by having an owner.
    out.byStatus[effectiveStatus] = (out.byStatus[effectiveStatus] ?? 0) + 1;
    if (repId) out.assigned += 1;
    else out.unassigned += 1;
    if (dryRun) continue;

    await q.query(
      `WITH n AS (SELECT nextval('crm_leads_id_seq') AS id)
       INSERT INTO crm_leads (id, public_id, contact_id, account_id, centre, event_date, event_time,
                              guests, event_type, source, is_prospect, kids, notes, mint_status,
                              capture_payload, created_by, status_id, assigned_rep_id, assigned_at,
                              value_cents, bmi_project_id, bmi_project_number, bmi_state_id,
                              bmi_state_name, bmi_person_id, bmi_synced_at)
       SELECT n.id, 'L-' || n.id::text, $1::bigint, $2::bigint, $3, $4::date, $5::time,
              $6::int, $7, $8, false, false, $9, 'minted',
              $10::jsonb, $11, $12, $13::bigint, CASE WHEN $13 IS NULL THEN NULL ELSE now() END,
              $14::bigint, $15, $16, $17, $18, $19, now()
         FROM n`,
      [
        r.contact_id,
        r.account_id,
        centre,
        r.event_date,
        r.event_start ? String(r.event_start).slice(0, 8) : null,
        Math.max(1, Number(r.persons ?? 1)),
        "group",
        "bmi",
        r.name ? `Adopted from BMI ${r.number ?? r.project_id}: ${r.name}` : null,
        JSON.stringify({ adoptedFrom: "crm_bmi_projects", stateName: r.state_name }),
        "crm-adopt",
        effectiveStatus,
        repId,
        Number(r.total_value_cents ?? 0),
        r.project_id,
        r.number,
        r.state_id,
        r.state_name,
        r.person_id,
      ],
    );
    out.adopted += 1;
  }

  out.unmatchedReps = [...unmatched].sort();
  return out;
}
