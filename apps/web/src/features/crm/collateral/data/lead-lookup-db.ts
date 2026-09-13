/**
 * A two-column, READ-ONLY projection of `crm_leads` so a share link can be
 * attributed to the deal it was sent about.
 *
 * WHY IT LIVES HERE AND NOT IN `leads`. The leads sub is B3's, and on this
 * branch it exports DDL only — there is no reader to import through its
 * `index.ts` yet. Rather than edit a file B3 is actively changing (a certain
 * rebase conflict) or invent a share flow with no lead on it, C6 keeps its own
 * narrow read: `id` and `public_id`, nothing else, no writes. The "one writer
 * per entity" rule is about WRITES; this never writes, and `crm_activities`
 * has an FK to `crm_leads(id)`, so an unresolvable lead has to be caught here
 * or the activity insert fails with a constraint error instead of a sentence.
 *
 * WHEN B3 LANDS: delete this module and call the leads sub's reader through
 * `~/features/crm/leads`. `service/share.ts` takes the lookup as a dependency
 * for exactly that reason — the swap is one line there and nothing else moves.
 */

import { isDbConfigured, sql } from "@ft/db";

export interface ShareLeadRef {
  /** `crm_leads.id` as text. */
  id: string;
  /** `crm_leads.public_id` — the `L-1042` style id the URLs use. */
  publicId: string;
  /** What the sheet prints: "L-1042 · Lee Health" style, best effort. */
  label: string;
}

const PUBLIC_ID_RE = /^[A-Za-z0-9-]{1,32}$/;
const NUMERIC_RE = /^\d{1,18}$/;

/**
 * Accepts either form the UI can hold: the numeric row id (what a deal drawer
 * has) or the public id (what a URL has). Anything else returns null WITHOUT
 * touching the database — a share is never worth a query on a hand-typed
 * string.
 */
export async function findShareLead(
  input: string | null | undefined,
): Promise<ShareLeadRef | null> {
  const value = (input ?? "").trim();
  if (!value || !isDbConfigured()) return null;
  const numeric = NUMERIC_RE.test(value);
  if (!numeric && !PUBLIC_ID_RE.test(value)) return null;

  const q = sql();
  /**
   * TWO PARAMETERS, ONE VALUE, and that is load-bearing. A single `$1` used as
   * BOTH `l.id = $1::bigint` and `l.public_id = $1` cannot be planned at all:
   * the cast fixes the parameter's type to bigint, and Postgres then refuses
   * `text = bigint` with "operator does not exist" — every share attributed to
   * a lead 500s before a link is ever minted, and no recording-SQL stub can
   * see it because the statement is never sent to a real planner. So the
   * numeric branch gets its own parameter, NULL whenever the input is not all
   * digits, and `$1` stays plain text for the public-id comparison.
   */
  const rows = (await q.query(
    `SELECT l.id::text AS id, l.public_id
       FROM crm_leads l
      WHERE ($2::bigint IS NOT NULL AND l.id = $2::bigint) OR l.public_id = $1
      LIMIT 1`,
    [value, numeric ? value : null],
  )) as { id: string; public_id: string }[];
  const row = rows[0];
  if (!row) return null;
  return { id: String(row.id), publicId: row.public_id, label: row.public_id };
}
