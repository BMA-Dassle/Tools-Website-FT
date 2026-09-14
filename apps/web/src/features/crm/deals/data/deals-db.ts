/**
 * THE ONE READ — every deal, however it got here.
 *
 * A deal is a BMI project with two overlays: the `crm_leads` row saying who is
 * working it, and the `group_function_quotes` row saying what the money is
 * doing. Pipeline, Contracts and Events are FILTERS over this, not three
 * separate queries. They used to be, and that is exactly why they disagreed:
 * measured on production, 177 open contracts of which only 71 had a lead — 106
 * sat on one screen and were invisible on the other.
 *
 * THE KEY SET IS A SUPERSET, NEVER A FILTER.
 *
 * `buildKeyCte` emits one identity row per deal, and the scope decides where
 * identity comes from:
 *
 *   project  every mirrored group project. 5,106 of them, and 4,615 have no
 *            contract at all, so a contract-first read could never show them.
 *   quote    keyed on the CONTRACT, so two quotes for one project stay two
 *            rows on a screen that is about contracts.
 *   board    the mirror UNIONed with every live lead. UNION, never UNION ALL:
 *            a lead whose project is mirrored yields the same key as the
 *            project and the two must COLLAPSE into one deal.
 *
 * A LEAD WITH NO PROJECT KEYS ON ITS OWN ROW ID, so it cannot vanish. Three
 * legitimate cases: the seconds between capture and mint (we write our row
 * FIRST, because guest data must be ours before an external call can fail); a
 * mint that FAILED and is on the retry queue, which is the highest-priority row
 * on the board and the very worst thing to hide; and a cold-list prospect,
 * which deliberately gets no Office project until a rep converts it.
 *
 * Owner's standing rule, 2026-09-13: "Don't write rows to block gaps we need to
 * do this right before we start using it." `spine` says which table supplied
 * the identity, so a screen SHOWS a gap instead of us manufacturing a row.
 *
 * THE OVERLAYS ARE LATERALS LIMITED TO ONE ROW. A plain LEFT JOIN would double
 * a deal the moment a project carried two quotes, and a doubled deal is a
 * double-counted pipeline.
 *
 * EVERY BOUND PARAMETER IS REFERENCED. Postgres refuses a statement carrying a
 * parameter nothing names — "could not determine data type of parameter $2" —
 * and that took out every Contracts window except the default once already.
 *
 * IDS ARE TEXT. A BMI project id is 17 digits and exceeds
 * `Number.MAX_SAFE_INTEGER`; `group_function_quotes.bmi_reservation_id` is
 * numeric in that table, so comparisons cast IT to text, never ours to a number.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { DealRowRaw } from "../projection";

/** Online/kiosk bookings. Open play, never group sales. */
export const ONLINE_KIND_ID = "-10";

export type DealScope = "project" | "quote" | "board";

export interface RepFilterKeys {
  /** `crm_reps.id` — who owns it in the CRM. */
  repId: string | null;
  /** Office user ids, one per centre; the roster column only holds Fort Myers. */
  officeIds: readonly string[];
  /** Lowercased names Office writes, including its own spellings. */
  officeNames: readonly string[];
  /** The planner email on a contract. */
  email: string | null;
}

export interface DealFilter {
  scope: DealScope;
  from?: string | null;
  until?: string | null;
  centre?: string | null;
  projectIds?: readonly string[] | null;
  rep?: RepFilterKeys | null;
  q?: string | null;
  /** Cold prospects belong on Cold lists, not the board. */
  excludeProspects?: boolean;
}

export interface DealQueryOptions {
  filter: DealFilter;
  limit?: number;
  offset?: number;
}

/** `$1`, `$2`, … in the order added. */
export interface Binder {
  params: unknown[];
  add(v: unknown): string;
}

export function binder(): Binder {
  const params: unknown[] = [];
  return {
    params,
    add(v: unknown): string {
      params.push(v);
      return `$${params.length}`;
    },
  };
}

/** BMI's date wins; a contract answers next, our own lead last. */
export const DEAL_EVENT_DATE = `COALESCE(p.event_date, q.event_date, l.event_date)`;

/** Office location id → the centre a planner would name. */
export const DEAL_CENTER_CODE = `
  CASE p.location_id
    WHEN 332160 THEN 'HPFM'
    WHEN 467486 THEN 'FT'
    WHEN 332145 THEN 'HPN'
    ELSE COALESCE(l.centre, NULLIF(UPPER(q.center_code), ''))
  END`;

/**
 * The identity rows for a scope.
 *
 * The window is applied HERE for the project-spined scopes, so the laterals
 * only run for rows that survive it. The quote scope cannot do that: a
 * contract's deal date may come from the project, so narrowing on
 * `q0.event_date` would drop rows the screen then shows on a different day —
 * it narrows on the merged date instead, in the outer WHERE.
 */
export function buildKeyCte(scope: DealScope, filter: DealFilter, b: Binder): string {
  // The quote scope reads NO project table, so it must bind nothing here.
  // Building the project predicate first and discarding it left `$1` bound and
  // unreferenced, which Postgres refuses outright — the same fault that took
  // out every Contracts window except the default once already.
  if (scope === "quote") {
    return `keys AS (
      SELECT q0.bmi_reservation_id::text AS key_project_id,
             q0.id::text                 AS key_quote_id,
             NULL::text                  AS key_lead_id
        FROM group_function_quotes q0
    )`;
  }

  const projectWhere: string[] = [`p0.kind_id IS DISTINCT FROM ${b.add(ONLINE_KIND_ID)}`];
  if (filter.from) projectWhere.push(`p0.event_date >= ${b.add(filter.from)}::date`);
  if (filter.until) projectWhere.push(`p0.event_date <= ${b.add(filter.until)}::date`);
  if (filter.projectIds?.length) {
    projectWhere.push(`p0.project_id = ANY(${b.add([...filter.projectIds])}::text[])`);
  }

  const projectSelect = `
      SELECT p0.project_id AS key_project_id,
             NULL::text    AS key_quote_id,
             NULL::text    AS key_lead_id
        FROM crm_bmi_projects p0
       WHERE ${projectWhere.join(" AND ")}`;

  if (scope === "project") return `keys AS (${projectSelect}\n    )`;

  // board: the mirror plus every live lead. A lead WITH a mirrored project
  // yields the identical key and UNION collapses the pair into one deal.
  return `keys AS (${projectSelect}

      UNION

      SELECT NULLIF(l0.bmi_project_id, '') AS key_project_id,
             NULL::text                    AS key_quote_id,
             CASE WHEN NULLIF(l0.bmi_project_id, '') IS NULL THEN l0.id::text END AS key_lead_id
        FROM crm_leads l0
       WHERE l0.archived_at IS NULL
    )`;
}

/**
 * The overlays. Each is a LATERAL limited to one row so neither can double a
 * deal, and the lead joins on the BMI PROJECT ID — never on `gf_short_id`,
 * which is NULL on every lead in production and always has been.
 */
export const DEAL_FROM = `
  FROM keys k
  LEFT JOIN crm_bmi_projects p ON p.project_id = k.key_project_id
  LEFT JOIN LATERAL (
    SELECT ll.*
      FROM crm_leads ll
     WHERE ll.archived_at IS NULL
       AND (ll.id::text = k.key_lead_id OR ll.bmi_project_id = k.key_project_id)
     ORDER BY ll.created_at DESC
     LIMIT 1
  ) l ON TRUE
  LEFT JOIN LATERAL (
    -- Columns listed explicitly, NOT \`qq.*\`. The wildcard already carries
    -- \`event_date\`, so re-labelling the merged date with the same name emitted
    -- it twice and every later \`q.event_date\` was ambiguous (Postgres 42702).
    SELECT qq.id, qq.contract_short_id, qq.status,
           qq.center_code, qq.center_name, qq.event_name, qq.event_number,
           qq.guest_count, qq.guest_first_name, qq.guest_last_name,
           qq.guest_email, qq.guest_phone,
           qq.approval_required, qq.is_tax_exempt,
           qq.total_cents, qq.tax_cents, qq.deposit_due_cents, qq.balance_cents,
           qq.collected_cents,
           qq.contract_sent_at, qq.contract_signed_at, qq.deposit_paid_at,
           qq.balance_paid_at, qq.balance_link_sent_at,
           qq.square_dayof_order_id, qq.square_settled_order_id,
           qq.square_gift_card_gan, qq.saved_card_brand, qq.saved_card_last4,
           qq.signed_pdf_url,
           qq.planner_email, qq.planner_first, qq.planner_last,
           qq.created_at, qq.updated_at,
           -- The DEAL's date, so a contract is judged on the day the event is
           -- actually on without a second copy of the predicate.
           COALESCE(p.event_date, qq.event_date::date) AS event_date
      FROM group_function_quotes qq
     WHERE qq.id::text = k.key_quote_id
        OR qq.bmi_reservation_id::text = k.key_project_id
     ORDER BY qq.created_at DESC
     LIMIT 1
  ) q ON TRUE
  LEFT JOIN crm_reps r ON r.id = l.assigned_rep_id
  LEFT JOIN crm_contacts c ON c.id = l.contact_id
  LEFT JOIN crm_accounts a ON a.id = l.account_id`;

export const DEAL_SELECT = `
  CASE
    WHEN p.project_id IS NOT NULL THEN 'project'
    WHEN k.key_quote_id IS NOT NULL THEN 'quote'
    ELSE 'lead'
  END AS spine,
  k.key_project_id, k.key_quote_id, k.key_lead_id,

  p.project_id AS p_project_id, p.client_key AS p_client_key, p.location_id AS p_location_id,
  p.number AS p_number, p.name AS p_name, p.state_id AS p_state_id, p.state_name AS p_state_name,
  p.kind_id AS p_kind_id, p.responsible_user_id AS p_responsible_user_id,
  p.responsible_name AS p_responsible_name,
  p.event_date::text AS p_event_date,
  to_char(p.event_start, 'HH24:MI') AS p_event_time,
  p.event_start::text AS p_event_start,
  p.persons AS p_persons,
  p.total_value_cents::text AS p_total_value_cents,
  p.balance_cents::text AS p_balance_cents,
  p.person_id AS p_person_id, p.person_name AS p_person_name,
  p.person_phone AS p_person_phone, p.person_email AS p_person_email,
  p.synced_at::text AS p_synced_at,

  l.id::text AS l_id, l.public_id AS l_public_id, l.status_id AS l_status_id,
  l.assigned_rep_id::text AS l_assigned_rep_id, l.assigned_at::text AS l_assigned_at,
  l.first_touch_at::text AS l_first_touch_at,
  l.next_action_kind AS l_next_action_kind, l.next_action_due::text AS l_next_action_due,
  l.next_action_label AS l_next_action_label,
  l.value_cents::text AS l_value_cents, l.source AS l_source, l.created_by AS l_created_by,
  l.created_at::text AS l_created_at,
  l.event_date::text AS l_event_date, l.event_time::text AS l_event_time,
  l.centre AS l_centre, l.guests AS l_guests,
  r.slug AS l_rep_slug, r.display_name AS l_rep_name,
  c.first_name AS l_guest_first, c.last_name AS l_guest_last,
  c.phone_e164 AS l_guest_phone, c.email AS l_guest_email,
  a.name AS l_account_name,

  q.id::text AS q_id, q.contract_short_id AS q_contract_short_id, q.status AS q_status,
  q.center_code AS q_center_code, q.center_name AS q_center_name,
  q.event_name AS q_event_name, q.event_number AS q_event_number,
  q.event_date::text AS q_event_date, q.guest_count AS q_guest_count,
  q.guest_first_name AS q_guest_first_name, q.guest_last_name AS q_guest_last_name,
  q.guest_email AS q_guest_email, q.guest_phone AS q_guest_phone,
  q.approval_required AS q_approval_required, q.is_tax_exempt AS q_is_tax_exempt,
  q.total_cents::text AS q_total_cents, q.tax_cents::text AS q_tax_cents,
  q.deposit_due_cents::text AS q_deposit_due_cents, q.balance_cents::text AS q_balance_cents,
  q.collected_cents::text AS q_collected_cents,
  q.contract_sent_at::text AS q_contract_sent_at,
  q.contract_signed_at::text AS q_contract_signed_at,
  q.deposit_paid_at::text AS q_deposit_paid_at,
  q.balance_paid_at::text AS q_balance_paid_at,
  q.balance_link_sent_at::text AS q_balance_link_sent_at,
  q.square_dayof_order_id AS q_square_dayof_order_id,
  q.square_settled_order_id AS q_square_settled_order_id,
  q.square_gift_card_gan AS q_square_gift_card_gan,
  q.saved_card_brand AS q_saved_card_brand, q.saved_card_last4 AS q_saved_card_last4,
  q.signed_pdf_url AS q_signed_pdf_url,
  q.planner_email AS q_planner_email, q.planner_first AS q_planner_first,
  q.planner_last AS q_planner_last,
  q.created_at::text AS q_created_at, q.updated_at::text AS q_updated_at`;

/** Guest, business, event, lead id or BMI number. Digits also search the phone. */
export function searchClause(term: string, b: Binder): string {
  const like = b.add(`%${term}%`);
  const clauses = [
    `p.name ILIKE ${like}`,
    `p.number ILIKE ${like}`,
    `p.person_name ILIKE ${like}`,
    `q.event_name ILIKE ${like}`,
    `q.event_number ILIKE ${like}`,
    `q.contract_short_id ILIKE ${like}`,
    `a.name ILIKE ${like}`,
    `l.public_id ILIKE ${like}`,
    `(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE ${like}`,
  ];
  const digits = term.replace(/\D/g, "");
  if (digits) {
    const d = b.add(`%${digits}%`);
    clauses.push(
      `regexp_replace(COALESCE(p.person_phone, ''), '[^0-9]', '', 'g') LIKE ${d}`,
      `regexp_replace(COALESCE(c.phone_e164, ''), '[^0-9]', '', 'g') LIKE ${d}`,
    );
  }
  return `(${clauses.join(" OR ")})`;
}

/**
 * A rep owns a deal through OUR lead first. The BMI and planner fallbacks apply
 * only when NOBODY owns it in the CRM, so a deal a director reassigned by hand
 * stops answering to its old Office owner.
 *
 * With no key at all this matches NOTHING rather than everything — a filter
 * that silently widens is worse than one that shows an empty board.
 */
export function repClause(keys: RepFilterKeys, b: Binder): string {
  const mine: string[] = [];
  if (keys.repId) mine.push(`l.assigned_rep_id = ${b.add(keys.repId)}::bigint`);

  const theirs: string[] = [];
  if (keys.officeIds.length) {
    theirs.push(`p.responsible_user_id = ANY(${b.add([...keys.officeIds])}::text[])`);
  }
  if (keys.officeNames.length) {
    theirs.push(`lower(p.responsible_name) = ANY(${b.add([...keys.officeNames])}::text[])`);
  }
  if (keys.email) theirs.push(`lower(q.planner_email) = ${b.add(keys.email.toLowerCase())}`);

  const parts: string[] = [...mine];
  if (theirs.length) parts.push(`(l.id IS NULL AND (${theirs.join(" OR ")}))`);
  return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
}

export function dealWhere(filter: DealFilter, b: Binder): string {
  const w: string[] = [];
  // The project-spined scopes already narrowed the KEY SET; the quote scope
  // narrows on the merged date here instead.
  if (filter.scope === "quote") {
    if (filter.from) w.push(`${DEAL_EVENT_DATE} >= ${b.add(filter.from)}::date`);
    if (filter.until) w.push(`${DEAL_EVENT_DATE} <= ${b.add(filter.until)}::date`);
  }
  if (filter.centre) w.push(`${DEAL_CENTER_CODE} = ${b.add(filter.centre)}`);
  if (filter.excludeProspects) w.push(`(l.id IS NULL OR l.is_prospect IS NOT TRUE)`);
  if (filter.rep) w.push(repClause(filter.rep, b));
  if (filter.q?.trim()) w.push(searchClause(filter.q.trim(), b));
  return w.length ? `WHERE ${w.join(" AND ")}` : "";
}

export function buildDealQuery(o: DealQueryOptions): { text: string; params: unknown[] } {
  const b = binder();
  const cte = buildKeyCte(o.filter.scope, o.filter, b);
  const where = dealWhere(o.filter, b);
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 1000);
  const text = `
    WITH ${cte}
    SELECT ${DEAL_SELECT}
    ${DEAL_FROM}
    ${where}
    ORDER BY ${DEAL_EVENT_DATE} DESC NULLS LAST,
             COALESCE(k.key_project_id, k.key_quote_id, k.key_lead_id)
    LIMIT ${b.add(limit)}::int OFFSET ${b.add(Math.max(o.offset ?? 0, 0))}::int`;
  return { text, params: b.params };
}

export async function queryDealRows(o: DealQueryOptions): Promise<DealRowRaw[]> {
  if (!isDbConfigured()) return [];
  const { text, params } = buildDealQuery(o);
  const q = sql();
  return (await q.query(text, params)) as DealRowRaw[];
}

export async function countDealRows(filter: DealFilter): Promise<number> {
  if (!isDbConfigured()) return 0;
  const b = binder();
  const cte = buildKeyCte(filter.scope, filter, b);
  const where = dealWhere(filter, b);
  const q = sql();
  const rows = (await q.query(
    `WITH ${cte} SELECT count(*)::int AS n ${DEAL_FROM} ${where}`,
    b.params,
  )) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}
