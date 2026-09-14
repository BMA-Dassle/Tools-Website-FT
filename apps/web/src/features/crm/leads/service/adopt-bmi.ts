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
    SELECT id::text AS id, role, bmi_user_id, lower(bmi_username) AS uname,
           lower(display_name) AS dname, lower(first_name) AS fname
      FROM crm_reps
     WHERE active IS TRUE
  `) as {
    id: string;
    role: string;
    bmi_user_id: string | null;
    uname: string | null;
    dname: string | null;
    fname: string | null;
  }[];
  const byOfficeId = new Map(reps.filter((r) => r.bmi_user_id).map((r) => [r.bmi_user_id!, r.id]));

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

  const states = Object.entries(ADOPTABLE_STATES).flatMap(([ck, m]) =>
    Object.keys(m).map((s) => `${ck}|${s}`),
  );

  const rows = (await q`
    SELECT p.project_id, p.client_key, p.location_id, p.number, p.name, p.state_id, p.state_name,
           p.responsible_user_id, p.responsible_name, p.event_date::text AS event_date,
           p.event_start::text AS event_start, p.persons, p.total_value_cents::text AS total_value_cents,
           p.person_id, p.account_id::text AS account_id, p.contact_id::text AS contact_id
      FROM crm_bmi_projects p
     WHERE p.kind_id IS DISTINCT FROM '-10'
       AND (p.client_key || '|' || COALESCE(p.state_id, '')) = ANY(${states}::text[])
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

    const statusId = ADOPTABLE_STATES[r.client_key]?.[String(r.state_id)] ?? "new";
    const repId =
      (r.responsible_user_id ? byOfficeId.get(r.responsible_user_id) : undefined) ??
      (r.responsible_name ? byName.get(r.responsible_name.toLowerCase()) : undefined) ??
      null;
    if (!repId && r.responsible_name) unmatched.add(r.responsible_name);

    // A deal BMI has already assigned is `assigned`, not `new` — the planner is
    // working it, and leaving it `new` would put it back in the unassigned
    // queue as though nobody had touched it.
    const effectiveStatus = statusId === "new" && repId ? "assigned" : statusId;
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
