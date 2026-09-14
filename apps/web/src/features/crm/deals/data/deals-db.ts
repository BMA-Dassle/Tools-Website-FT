/**
 * THE ONE READ. `crm_bmi_projects` LEFT JOIN `crm_leads` LEFT JOIN
 * `group_function_quotes` — the BMI project is the spine and our two tables
 * are overlays hung off it.
 *
 * Pipeline, Contracts and Events all come through here. They differ by SCOPE
 * (which slice of the spine they key on) and by the filters they pass, never
 * by having their own query. That is the whole fix: two screens cannot
 * disagree about what exists when there is one statement that says what exists.
 *
 * THE JOIN KEY IS THE BMI PROJECT ID, never `crm_leads.gf_short_id`. That
 * column is NULL on all 187 leads and nothing has ever written it, which is
 * why the deal drawer said "no quote yet" for a deal whose contract, deposit
 * and payment history were one table away.
 *
 * LOSSLESS BY CONSTRUCTION. The key set is a UNION, not a filter: a quote
 * whose project is missing from the mirror (68 rows, 11 open) and a lead
 * minted without one (2 rows) key on their own row id. `spine` says which
 * table supplied the identity so the screen can show the gap. Nothing is
 * adopted, backfilled or minted to make a list look full.
 *
 * NO ORM AND NO `Number()` ON AN ID. Every id column is TEXT in and TEXT out;
 * money is BIGINT rendered `::text` and parsed in the projection. A 17-digit
 * Pandora project id that goes through a JS number comes back off by one.
 *
 * PERFORMANCE. The narrowing happens in the key CTE, before the two laterals
 * run, wherever that is provably exact — for the project-spined scopes the
 * deal's date and centre ARE the project's columns, so pushing the window down
 * cannot move a row. The quote-spined scope keys on 559 rows and filters
 * afterwards on the merged expression instead, because there the deal's date
 * can come from the project rather than the contract.
 */

import { isDbConfigured, sql } from "@ft/db";
import { CENTRE_LIST } from "../../core/centres";
import { ISO } from "../../leads/data/sql";
import { DEAL_PAGE_MAX, type DealFilter, type DealScope } from "../contracts";
import { ensureDealSchemas } from "../transport";
import type { DealRowRaw } from "../projection";

// ---------------------------------------------------------------------------
// Merged expressions — the deal's own view of date and centre
// ---------------------------------------------------------------------------

/**
 * BMI first. When Office and a signed contract disagree about the day, Office
 * is where the event actually is: a reschedule moves the project days before
 * anyone re-issues the PDF. Measured 2026-09-13: 7 of 491 joined rows differ.
 */
export const DEAL_EVENT_DATE = `COALESCE(p.event_date, q.event_date, l.event_date)`;

/** `CASE p.location_id WHEN … END`, generated from the ONE centre table. */
function centerCodeFromLocation(col: string): string {
  const arms = CENTRE_LIST.map((c) => `WHEN ${c.locationId} THEN '${c.centerCode}'`).join(" ");
  return `CASE ${col} ${arms} END`;
}

function centerCodeFromCentre(col: string): string {
  const arms = CENTRE_LIST.map((c) => `WHEN '${c.code}' THEN '${c.centerCode}'`).join(" ");
  return `CASE ${col} ${arms} END`;
}

export const DEAL_CENTER_CODE = `COALESCE(${centerCodeFromLocation("p.location_id")}, q.center_code, ${centerCodeFromCentre("l.centre")})`;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const PROJECT_COLUMNS = `
  p.project_id AS p_project_id, p.client_key AS p_client_key, p.location_id AS p_location_id,
  p.number AS p_number, p.name AS p_name, p.state_id AS p_state_id, p.state_name AS p_state_name,
  p.kind_id AS p_kind_id, p.responsible_user_id AS p_responsible_user_id,
  p.responsible_name AS p_responsible_name,
  to_char(p.event_date, 'YYYY-MM-DD') AS p_event_date,
  to_char(p.event_start, 'HH24:MI') AS p_event_time,
  ${ISO("p.event_start")} AS p_event_start,
  p.persons AS p_persons,
  p.total_value_cents::text AS p_total_value_cents,
  p.balance_cents::text AS p_balance_cents,
  p.person_id AS p_person_id, p.person_name AS p_person_name,
  p.person_phone AS p_person_phone, p.person_email AS p_person_email,
  ${ISO("p.synced_at")} AS p_synced_at
`;

const LEAD_COLUMNS = `
  l.id::text AS l_id, l.public_id AS l_public_id, l.status_id AS l_status_id,
  l.assigned_rep_id::text AS l_assigned_rep_id, ${ISO("l.assigned_at")} AS l_assigned_at,
  ${ISO("l.first_touch_at")} AS l_first_touch_at,
  l.next_action_kind AS l_next_action_kind, ${ISO("l.next_action_due")} AS l_next_action_due,
  l.next_action_label AS l_next_action_label, l.value_cents::text AS l_value_cents,
  l.source AS l_source, l.created_by AS l_created_by, ${ISO("l.created_at")} AS l_created_at,
  to_char(l.event_date, 'YYYY-MM-DD') AS l_event_date,
  to_char(l.event_time, 'HH24:MI') AS l_event_time,
  l.centre AS l_centre, l.guests AS l_guests,
  r.slug AS l_rep_slug, r.display_name AS l_rep_name,
  c.first_name AS l_guest_first, c.last_name AS l_guest_last,
  c.phone_e164 AS l_guest_phone, c.email AS l_guest_email, a.name AS l_account_name
`;

const QUOTE_COLUMNS = `
  q.id::text AS q_id, q.contract_short_id AS q_contract_short_id, q.status AS q_status,
  q.center_code AS q_center_code, q.center_name AS q_center_name,
  q.event_name AS q_event_name, q.event_number AS q_event_number,
  to_char(q.event_date, 'YYYY-MM-DD') AS q_event_date,
  q.guest_count AS q_guest_count, q.guest_first_name AS q_guest_first_name,
  q.guest_last_name AS q_guest_last_name, q.guest_email AS q_guest_email,
  q.guest_phone AS q_guest_phone, q.approval_required AS q_approval_required,
  q.is_tax_exempt AS q_is_tax_exempt,
  q.total_cents::text AS q_total_cents, q.tax_cents::text AS q_tax_cents,
  q.deposit_due_cents::text AS q_deposit_due_cents, q.balance_cents::text AS q_balance_cents,
  q.collected_cents::text AS q_collected_cents,
  ${ISO("q.contract_sent_at")} AS q_contract_sent_at,
  ${ISO("q.contract_signed_at")} AS q_contract_signed_at,
  ${ISO("q.deposit_paid_at")} AS q_deposit_paid_at,
  ${ISO("q.balance_paid_at")} AS q_balance_paid_at,
  ${ISO("q.balance_link_sent_at")} AS q_balance_link_sent_at,
  q.square_dayof_order_id AS q_square_dayof_order_id,
  q.square_settled_order_id AS q_square_settled_order_id,
  q.square_gift_card_gan AS q_square_gift_card_gan,
  q.saved_card_brand AS q_saved_card_brand, q.saved_card_last4 AS q_saved_card_last4,
  q.signed_pdf_url AS q_signed_pdf_url, q.planner_email AS q_planner_email,
  q.planner_first AS q_planner_first, q.planner_last AS q_planner_last,
  ${ISO("q.created_at")} AS q_created_at, ${ISO("q.updated_at")} AS q_updated_at
`;

/**
 * `spine` is a fact about the ROW, not about the lens that asked: it names the
 * table the deal's identity came from, so the 11 open contracts whose project
 * the mirror has never seen arrive labelled rather than absent.
 */
const SPINE_COLUMN = `
  CASE
    WHEN p.project_id IS NOT NULL THEN 'project'
    WHEN k.key_quote_id IS NOT NULL THEN 'quote'
    ELSE 'lead'
  END AS spine,
  k.key_project_id, k.key_quote_id, k.key_lead_id
`;

export const DEAL_SELECT = `${SPINE_COLUMN}, ${PROJECT_COLUMNS}, ${LEAD_COLUMNS}, ${QUOTE_COLUMNS}`;

/**
 * The two overlays, as LATERALs.
 *
 * A lateral rather than a plain join because a project could in principle
 * carry two leads or two quotes, and a plain join would silently DOUBLE the
 * deal. One row in, one row out, most-recently-updated wins.
 *
 * The quote lateral re-labels `event_date` to the DEAL's date (BMI first).
 * That is what lets `ATTENTION_SQL` — which is written against `q.*` — judge a
 * contract on the day the event is actually on, without a second copy of the
 * predicate. `q_event_date` above still reports the quote's own date, so the
 * two are never confused.
 */
export const DEAL_FROM = `
  FROM k
  LEFT JOIN crm_bmi_projects p ON p.project_id = k.key_project_id
  LEFT JOIN LATERAL (
    SELECT ll.*
      FROM crm_leads ll
     WHERE ll.archived_at IS NULL
       AND ( (k.key_project_id IS NOT NULL AND ll.bmi_project_id = k.key_project_id)
          OR (k.key_lead_id IS NOT NULL AND ll.id = k.key_lead_id::bigint) )
     ORDER BY ll.updated_at DESC, ll.id DESC
     LIMIT 1
  ) l ON TRUE
  LEFT JOIN LATERAL (
    SELECT qq.id, qq.contract_short_id, qq.status, qq.center_code, qq.center_name,
           qq.event_name, qq.event_number,
           COALESCE(p.event_date, qq.event_date::date) AS event_date,
           qq.guest_count, qq.guest_first_name, qq.guest_last_name, qq.guest_email,
           qq.guest_phone, qq.approval_required, qq.is_tax_exempt,
           qq.total_cents, qq.tax_cents, qq.deposit_due_cents, qq.balance_cents,
           qq.collected_cents, qq.contract_sent_at, qq.contract_signed_at,
           qq.deposit_paid_at, qq.balance_paid_at, qq.balance_link_sent_at,
           qq.square_dayof_order_id, qq.square_settled_order_id, qq.square_gift_card_gan,
           qq.saved_card_brand, qq.saved_card_last4, qq.signed_pdf_url,
           qq.planner_email, qq.planner_first, qq.planner_last,
           qq.created_at, qq.updated_at
      FROM group_function_quotes qq
     WHERE (k.key_quote_id IS NOT NULL AND qq.id = k.key_quote_id::bigint)
        OR (k.key_quote_id IS NULL AND k.key_project_id IS NOT NULL
            AND qq.bmi_reservation_id = k.key_project_id)
     ORDER BY qq.updated_at DESC NULLS LAST, qq.id DESC
     LIMIT 1
  ) q ON TRUE
  LEFT JOIN crm_contacts c ON c.id = l.contact_id
  LEFT JOIN crm_accounts a ON a.id = l.account_id
  LEFT JOIN crm_reps r ON r.id = l.assigned_rep_id
`;

// ---------------------------------------------------------------------------
// Parameter binder
// ---------------------------------------------------------------------------

export interface Binder {
  params: unknown[];
  add(v: unknown): string;
}

export function binder(seed: readonly unknown[] = []): Binder {
  const params: unknown[] = [...seed];
  return {
    params,
    add(v: unknown): string {
      params.push(v);
      return `$${params.length}`;
    },
  };
}

// ---------------------------------------------------------------------------
// The key set
// ---------------------------------------------------------------------------

/** Group functions only — the online-booking rows (`-10`) are not deals. */
export const ONLINE_KIND_ID = "-10";

/**
 * The key CTE: one row per deal, `(project_id, quote_id, lead_id)` with only
 * the spine column set.
 *
 * `board` UNIONs (not UNION ALL) the mirror with every live lead, so a lead
 * whose project IS mirrored contributes the same key as the project and the
 * two collapse into one deal — which is precisely the "one record" the owner
 * asked for.
 *
 * EACH BRANCH BINDS ITS OWN PARAMETERS, and only when it is actually emitted.
 * Postgres refuses a statement carrying a parameter nothing references — "could
 * not determine data type of parameter $1" — so a key set built eagerly and
 * then thrown away takes the whole query down. That is the same failure that
 * 500'd every Contracts window except the default a day earlier; it is stated
 * here so it cannot come back through a different door.
 */
export function buildKeyCte(scope: DealScope, filter: DealFilter, b: Binder): string {
  const projectKeys = () => {
    const where: string[] = [`p0.kind_id IS DISTINCT FROM ${b.add(ONLINE_KIND_ID)}`];
    if (filter.from) where.push(`p0.event_date >= ${b.add(filter.from)}::date`);
    if (filter.until) where.push(`p0.event_date <= ${b.add(filter.until)}::date`);
    if (filter.centre) {
      const centre = CENTRE_LIST.find((c) => c.code === filter.centre);
      if (centre) where.push(`p0.location_id = ${b.add(centre.locationId)}`);
    }
    if (filter.projectIds?.length) {
      where.push(`p0.project_id = ANY(${b.add([...filter.projectIds])}::text[])`);
    }
    return `
    SELECT p0.project_id AS key_project_id, NULL::text AS key_quote_id, NULL::text AS key_lead_id
      FROM crm_bmi_projects p0
     WHERE ${where.join(" AND ")}`;
  };

  const leadKeys = () => {
    const where: string[] = [`l0.archived_at IS NULL`];
    if (filter.from) where.push(`l0.event_date >= ${b.add(filter.from)}::date`);
    if (filter.until) where.push(`l0.event_date <= ${b.add(filter.until)}::date`);
    if (filter.centre) where.push(`l0.centre = ${b.add(filter.centre)}`);
    if (filter.projectIds?.length) {
      where.push(`l0.bmi_project_id = ANY(${b.add([...filter.projectIds])}::text[])`);
    }
    return `
    SELECT NULLIF(l0.bmi_project_id, '') AS key_project_id,
           NULL::text AS key_quote_id,
           CASE WHEN NULLIF(l0.bmi_project_id, '') IS NULL THEN l0.id::text END AS key_lead_id
      FROM crm_leads l0
     WHERE ${where.join(" AND ")}`;
  };

  // The quote key set is 559 rows and is NOT narrowed here: a contract's deal
  // date can come from the project rather than from the contract, so the window
  // is applied outside, on the merged expression the row will display.
  const quoteKeys = () => {
    const where: string[] = [];
    if (filter.projectIds?.length) {
      where.push(
        `NULLIF(q0.bmi_reservation_id, '') = ANY(${b.add([...filter.projectIds])}::text[])`,
      );
    }
    return `
    SELECT NULLIF(q0.bmi_reservation_id, '') AS key_project_id,
           q0.id::text AS key_quote_id,
           NULL::text AS key_lead_id
      FROM group_function_quotes q0
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  };

  if (scope === "quote") return `WITH k AS (${quoteKeys()})`;
  if (scope === "project") return `WITH k AS (${projectKeys()})`;
  return `WITH k AS (${projectKeys()} UNION ${leadKeys()})`;
}

// ---------------------------------------------------------------------------
// Outer filters — evaluated on the MERGED expressions
// ---------------------------------------------------------------------------

/**
 * The search box, over every name a planner might type: the event, the guest,
 * the company, the BMI number, the contract short id and a phone number in any
 * punctuation. It reaches all three tables because the deal is all three.
 */
export function searchClause(term: string, b: Binder): string {
  const like = b.add(`%${term}%`);
  const clauses = [
    `q.event_name ILIKE ${like}`,
    `p.name ILIKE ${like}`,
    `q.guest_first_name ILIKE ${like}`,
    `q.guest_last_name ILIKE ${like}`,
    `(q.guest_first_name || ' ' || q.guest_last_name) ILIKE ${like}`,
    `q.guest_email ILIKE ${like}`,
    `q.event_number ILIKE ${like}`,
    `q.contract_short_id ILIKE ${like}`,
    `p.number ILIKE ${like}`,
    `p.person_name ILIKE ${like}`,
    `p.person_email ILIKE ${like}`,
    `c.first_name ILIKE ${like}`,
    `c.last_name ILIKE ${like}`,
    `(c.first_name || ' ' || c.last_name) ILIKE ${like}`,
    `c.email ILIKE ${like}`,
    `a.name ILIKE ${like}`,
    `l.public_id ILIKE ${like}`,
  ];
  // The phone branch EXISTS only when the search actually holds digits: a
  // "never matches" sentinel would have to be a string `text` can carry, and
  // the obvious one is exactly what it cannot, so every digit-less search
  // would 500 rather than search by name.
  const digits = term.replace(/\D/g, "");
  if (digits) {
    const d = b.add(`%${digits}%`);
    clauses.push(
      `regexp_replace(COALESCE(q.guest_phone, ''), '[^0-9]', '', 'g') LIKE ${d}`,
      `regexp_replace(COALESCE(p.person_phone, ''), '[^0-9]', '', 'g') LIKE ${d}`,
      `regexp_replace(COALESCE(c.phone_e164, ''), '[^0-9]', '', 'g') LIKE ${d}`,
    );
  }
  return `(${clauses.join(" OR ")})`;
}

/**
 * A rep filter must mean the same thing on every lens, so it matches the deal's
 * OWNER however the deal came by one: the lead's assignee first, then Office's
 * `responsible`, then the contract's planner. A slug the roster does not know
 * matches nothing — a filter that silently stops filtering is how a rep ends up
 * looking at the whole board.
 */
export interface RepFilterKeys {
  repId: string | null;
  officeIds: readonly string[];
  officeNames: readonly string[];
  email: string | null;
}

export function repClause(keys: RepFilterKeys, b: Binder): string {
  const owned: string[] = [];
  if (keys.repId) owned.push(`l.assigned_rep_id = ${b.add(keys.repId)}::bigint`);
  const unowned: string[] = [];
  if (keys.officeIds.length) {
    unowned.push(`p.responsible_user_id = ANY(${b.add([...keys.officeIds])}::text[])`);
  }
  if (keys.officeNames.length) {
    unowned.push(`lower(btrim(p.responsible_name)) = ANY(${b.add([...keys.officeNames])}::text[])`);
  }
  if (keys.email) unowned.push(`lower(q.planner_email) = ${b.add(keys.email)}`);
  const fallback = unowned.length ? `(l.id IS NULL AND (${unowned.join(" OR ")}))` : null;
  const all = [...owned, ...(fallback ? [fallback] : [])];
  // Nothing to match on at all → match nothing, never everything.
  return all.length ? `(${all.join(" OR ")})` : `FALSE`;
}

export function dealWhere(filter: DealFilter, b: Binder, extra: readonly string[] = []): string[] {
  const where: string[] = [...extra];
  // The quote-spined scope did not narrow its key set, so the window is applied
  // here — on the MERGED date, which is the one the row will display.
  if (filter.scope === "quote") {
    if (filter.from) where.push(`${DEAL_EVENT_DATE} >= ${b.add(filter.from)}::date`);
    if (filter.until) where.push(`${DEAL_EVENT_DATE} <= ${b.add(filter.until)}::date`);
    if (filter.centre) {
      const centre = CENTRE_LIST.find((c) => c.code === filter.centre);
      if (centre) where.push(`${DEAL_CENTER_CODE} = ${b.add(centre.centerCode)}`);
    }
  }
  if (filter.q) where.push(searchClause(filter.q, b));
  return where;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface DealQueryOptions {
  filter: DealFilter;
  /** Extra SQL predicates, already bound through the same binder. */
  where?: readonly string[];
  /** Bound BEFORE anything else, for predicates that name `$1`, `$2` literally. */
  seedParams?: readonly unknown[];
  orderBy?: string;
  limit?: number;
  binder?: Binder;
}

export function buildDealQuery(opts: DealQueryOptions): { text: string; params: unknown[] } {
  const b = opts.binder ?? binder(opts.seedParams ?? []);
  const cte = buildKeyCte(opts.filter.scope, opts.filter, b);
  const where = dealWhere(opts.filter, b, opts.where ?? []);
  const limit = Math.min(Math.max(opts.limit ?? DEAL_PAGE_MAX, 1), DEAL_PAGE_MAX);
  const order = opts.orderBy ?? `${DEAL_EVENT_DATE} ASC NULLS LAST, k.key_project_id ASC`;
  const text = `${cte}
    SELECT ${DEAL_SELECT}
    ${DEAL_FROM}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${order}
    LIMIT ${b.add(limit)}`;
  return { text, params: b.params };
}

/** The raw rows, unprojected — callers hand them to `toDeal`. */
export async function queryDealRows(opts: DealQueryOptions): Promise<DealRowRaw[]> {
  if (!isDbConfigured()) return [];
  await ensureDealSchemas();
  const built = buildDealQuery(opts);
  const q = sql();
  return (await q.query(built.text, built.params)) as DealRowRaw[];
}

/** `count(*)` over the same key set and predicates, without the page. */
export async function countDealRows(opts: Omit<DealQueryOptions, "limit">): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureDealSchemas();
  const b = opts.binder ?? binder(opts.seedParams ?? []);
  const cte = buildKeyCte(opts.filter.scope, opts.filter, b);
  const where = dealWhere(opts.filter, b, opts.where ?? []);
  const text = `${cte}
    SELECT count(*)::int AS n
    ${DEAL_FROM}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const q = sql();
  const rows = (await q.query(text, b.params)) as { n: number }[];
  return Number(rows[0]?.n ?? 0) || 0;
}
