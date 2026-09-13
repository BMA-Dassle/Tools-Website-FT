/**
 * The Contracts screen's one read: `group_function_quotes` filtered by window,
 * status, centre, rep and search, ordered by EVENT DATE, keyset-paginated 25 a
 * page (prototype `PER`), plus the four tiles.
 *
 * WHY THE ATTENTION PREDICATE IS IN SQL (`ATTENTION_SQL`): the default view is
 * "Needs attention", so filtering it in JavaScript would mean reading rows
 * until enough survived — the shape of the portal's 500-row cap, which
 * under-reported for months (R10, plan Context). The predicate is expressed
 * once for Postgres and once for TypeScript and `attention.test.ts` pins that
 * they agree branch for branch; the JS copy then only builds the PILLS.
 *
 * ET, NOT UTC: "days out" is a calendar count in America/New_York, so today's
 * ET date is computed here and bound as a parameter. `now()` inside Postgres is
 * UTC and would move the boundary for five hours every evening — the exact bug
 * that dropped 18 of 20 RAINYDAY rows.
 *
 * The rep filter is a `crm_reps` SLUG, resolved to the planner's email here:
 * `group_function_quotes` records the planner by email, and a CRM screen must
 * never make the director type one.
 */

import { isDbConfigured, sql } from "@ft/db";
import { listLeadContractRefs } from "~/features/crm/leads";
import { listReps } from "~/features/crm/reps";
import { centreByCode } from "../../core/centres";
import { todayEasternYmd } from "../../core/dates";
import type { CentreCode } from "../../core/types";
import {
  CLOSED_GF_STATUSES,
  CONTRACTS_PAGE_MAX,
  CONTRACTS_PAGE_SIZE,
  type ContractCounts,
  type ContractRow,
  type ContractStatusFilter,
  type ContractWindow,
} from "../contracts";
import { ensureGfSchema } from "../transport";
import {
  ATTENTION_SQL,
  PAST_UNPAID_DAYOF_SQL,
  UNSIGNED_AGE_MINUTES,
  attentionSql,
} from "./attention";
import { repIndexByEmail, toContractRow, type QuoteRowSource, type RowContext } from "./rows";

export const QUOTE_COLUMNS = `
  q.id, q.contract_short_id, q.bmi_reservation_id, q.center_code, q.center_name,
  q.event_name, q.event_number, to_char(q.event_date, 'YYYY-MM-DD') AS event_date,
  q.guest_count, q.guest_first_name, q.guest_last_name, q.guest_email, q.guest_phone,
  q.status, q.approval_required, q.is_tax_exempt,
  q.total_cents, q.tax_cents, q.deposit_due_cents, q.balance_cents, q.collected_cents,
  q.contract_sent_at, q.contract_signed_at, q.deposit_paid_at, q.balance_paid_at,
  q.balance_link_sent_at, q.square_dayof_order_id, q.square_settled_order_id,
  q.square_gift_card_gan, q.saved_card_brand, q.saved_card_last4, q.signed_pdf_url,
  q.planner_email, q.planner_first, q.planner_last, q.created_at, q.updated_at
`;

export interface ContractListFilter {
  win?: ContractWindow;
  status?: ContractStatusFilter;
  centre?: CentreCode;
  /** A `crm_reps` slug. */
  rep?: string;
  q?: string;
  closed?: boolean;
  cursor?: string | null;
  limit?: number;
  now?: Date;
}

/**
 * A TYPE ALIAS, not an interface, and deliberately: `withCrmRoute` constrains a
 * handler's result to `Record<string, unknown>`, and an interface has no
 * implicit index signature, so an interface return type does not satisfy it.
 * Every shape a route hands back directly is written this way.
 */
export type ContractListPage = {
  rows: ContractRow[];
  nextCursor: string | null;
  total: number;
  counts: ContractCounts;
};

export const EMPTY_COUNTS: ContractCounts = {
  attention: 0,
  pendingApproval: 0,
  outUnsigned: 0,
  outUnsignedCents: 0,
  depositsHeldCents: 0,
  balanceOutstandingCents: 0,
};

/** Keyset on (event_date ASC, id ASC) — the screen's own sort order. */
export function encodeContractCursor(eventDate: string, id: string): string {
  return Buffer.from(`${eventDate}|${id}`, "utf8").toString("base64url");
}

export function decodeContractCursor(
  cursor: string | null | undefined,
): { eventDate: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const bar = raw.lastIndexOf("|");
    if (bar < 0) return null;
    const eventDate = raw.slice(0, bar);
    const id = raw.slice(bar + 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !/^\d{1,18}$/.test(id)) return null;
    return { eventDate, id };
  } catch {
    return null;
  }
}

/** A tiny parameter collector — `$1`, `$2`, … in the order they are added. */
function binder() {
  const params: unknown[] = [];
  return {
    params,
    add(v: unknown): string {
      params.push(v);
      return `$${params.length}`;
    },
  };
}

interface WhereBuild {
  where: string[];
  params: unknown[];
}

/**
 * Every filter except the cursor, as SQL.
 *
 * A clock value is bound ONLY by the branch that uses it. Postgres types a
 * parameter from where it appears, so binding today and the unsigned cut-off
 * up front and then building "All dates" (which mentions neither) or "Next 30
 * days" (which mentions only today) leaves a parameter with no type and the
 * statement is rejected outright — "could not determine data type of parameter
 * $2". That took out five of the six windows; `attention`, the default, was
 * the only one whose clause happened to reference both.
 */
export function buildContractWhere(
  filter: ContractListFilter,
  todayYmd: string,
  plannerEmail: string | null,
  now: Date,
): WhereBuild {
  const b = binder();
  const where: string[] = [];
  const win = filter.win ?? "attention";

  if (win === "attention") {
    const today = b.add(todayYmd);
    const cutoff = b.add(new Date(now.getTime() - UNSIGNED_AGE_MINUTES * 60_000).toISOString());
    where.push(attentionSql(today, cutoff));
  } else if (win === "past") {
    where.push(`q.event_date < ${b.add(todayYmd)}::date`);
  } else if (win !== "all") {
    const today = b.add(todayYmd);
    where.push(
      `q.event_date >= ${today}::date AND q.event_date <= (${today}::date + ${Number(win)})`,
    );
  }

  // The prototype hides closed contracts everywhere but the Past window, and
  // the archive toggle brings them back (crm-events.js:218).
  if (!filter.closed && win !== "past") {
    where.push(`q.status <> ALL(${b.add([...CLOSED_GF_STATUSES])}::text[])`);
  }

  if (filter.centre) where.push(`q.center_code = ${b.add(centreByCode(filter.centre).centerCode)}`);
  if (plannerEmail) where.push(`lower(q.planner_email) = ${b.add(plannerEmail)}`);
  if (filter.status && filter.status !== "all") where.push(`q.status = ${b.add(filter.status)}`);

  if (filter.q) {
    const like = b.add(`%${filter.q}%`);
    const digits = filter.q.replace(/\D/g, "");
    const clauses = [
      `q.event_name ILIKE ${like}`,
      `q.guest_first_name ILIKE ${like}`,
      `q.guest_last_name ILIKE ${like}`,
      `(q.guest_first_name || ' ' || q.guest_last_name) ILIKE ${like}`,
      `q.guest_email ILIKE ${like}`,
      `q.event_number ILIKE ${like}`,
      `q.contract_short_id ILIKE ${like}`,
    ];
    // The phone branch EXISTS only when the search actually holds digits.
    // A "never matches" sentinel bound in its place would have to be a string
    // Postgres can carry, and the obvious one — a NUL-prefixed literal — is
    // exactly what `text` cannot hold: the driver rejects the whole statement,
    // so every digit-less search would 500 rather than search by name.
    if (digits) {
      clauses.push(
        `regexp_replace(COALESCE(q.guest_phone, ''), '[^0-9]', '', 'g') LIKE ${b.add(`%${digits}%`)}`,
      );
    }
    where.push(`(${clauses.join(" OR ")})`);
  }

  return { where, params: b.params };
}

function whereSql(where: string[]): string {
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

/**
 * The four tiles and the attention badge, over ALL open contracts — never over
 * the current page. The attention count follows the prototype's own expression
 * (`(hasReasons && !closed) || pastUnpaidDayof`, crm-events.js:213) exactly,
 * parentheses included.
 */
export async function contractCounts(now = new Date()): Promise<ContractCounts> {
  if (!isDbConfigured()) return EMPTY_COUNTS;
  await ensureGfSchema();
  const q = sql();
  const todayYmd = todayEasternYmd(now);
  const unsignedCutoff = new Date(now.getTime() - UNSIGNED_AGE_MINUTES * 60_000).toISOString();
  const closed = [...CLOSED_GF_STATUSES];

  const rows = (await q.query(
    `SELECT
       count(*) FILTER (WHERE (${ATTENTION_SQL} AND q.status <> ALL($3::text[])) OR ${PAST_UNPAID_DAYOF_SQL})::int AS attention,
       count(*) FILTER (WHERE q.status = 'pending_approval')::int AS pending_approval,
       count(*) FILTER (WHERE q.status = 'contract_sent')::int AS out_unsigned,
       COALESCE(sum(q.total_cents) FILTER (WHERE q.status = 'contract_sent'), 0)::bigint AS out_unsigned_cents,
       COALESCE(sum(q.deposit_due_cents) FILTER (WHERE q.status <> ALL($3::text[]) AND q.deposit_paid_at IS NOT NULL), 0)::bigint AS deposits_held_cents,
       COALESCE(sum(q.balance_cents) FILTER (WHERE q.status <> ALL($3::text[])), 0)::bigint AS balance_outstanding_cents
     FROM group_function_quotes q`,
    [todayYmd, unsignedCutoff, closed],
  )) as Record<string, string | number>[];

  const r = rows[0] ?? {};
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
  return {
    attention: n(r.attention),
    pendingApproval: n(r.pending_approval),
    outUnsigned: n(r.out_unsigned),
    outUnsignedCents: n(r.out_unsigned_cents),
    depositsHeldCents: n(r.deposits_held_cents),
    balanceOutstandingCents: n(r.balance_outstanding_cents),
  };
}

export async function rowContext(rows: QuoteRowSource[], now: Date): Promise<RowContext> {
  const reps = await listReps({ includeInactive: true }).catch(() => []);
  const shortIds = rows.map((r) => r.contract_short_id).filter((s): s is string => Boolean(s));
  const projectIds = rows.map((r) => String(r.bmi_reservation_id));
  const refs = await listLeadContractRefs({ shortIds, projectIds }).catch(() => []);
  const leadByShortId = new Map<string, string>();
  const leadByProjectId = new Map<string, string>();
  for (const ref of refs) {
    if (ref.gfShortId) leadByShortId.set(ref.gfShortId, ref.publicId);
    if (ref.bmiProjectId) leadByProjectId.set(ref.bmiProjectId, ref.publicId);
  }
  return { now, repsByEmail: repIndexByEmail(reps), leadByShortId, leadByProjectId };
}

/** The screen's read. `limit` is clamped to 200 (R10); the screen asks for 25. */
export async function listContracts(filter: ContractListFilter = {}): Promise<ContractListPage> {
  const now = filter.now ?? new Date();
  if (!isDbConfigured()) {
    return { rows: [], nextCursor: null, total: 0, counts: EMPTY_COUNTS };
  }
  await ensureGfSchema();

  let plannerEmail: string | null = null;
  if (filter.rep) {
    const reps = await listReps({ includeInactive: true }).catch(() => []);
    const rep = reps.find((r) => r.slug === filter.rep);
    const email = rep?.email?.toLowerCase();
    // A slug we do not know must return NOTHING, never "every contract": a
    // filter that silently stops filtering is how a rep sees the whole board.
    // Said by returning an empty page rather than by binding an unmatchable
    // sentinel — the tiles still count every open contract, as the prototype's
    // do, because they were never scoped by the rep filter.
    if (!email) {
      return { rows: [], nextCursor: null, total: 0, counts: await contractCounts(now) };
    }
    plannerEmail = email;
  }

  const todayYmd = todayEasternYmd(now);
  const built = buildContractWhere(filter, todayYmd, plannerEmail, now);
  const limit = Math.min(Math.max(filter.limit ?? CONTRACTS_PAGE_SIZE, 1), CONTRACTS_PAGE_MAX);

  const params = [...built.params];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = [...built.where];
  const cur = decodeContractCursor(filter.cursor);
  if (cur) {
    where.push(`(q.event_date, q.id) > (${add(cur.eventDate)}::date, ${add(cur.id)}::bigint)`);
  }

  const q = sql();
  const [pageRaw, totalRaw, counts] = await Promise.all([
    q.query(
      `SELECT ${QUOTE_COLUMNS}
         FROM group_function_quotes q
         ${whereSql(where)}
        ORDER BY q.event_date ASC, q.id ASC
        LIMIT ${add(limit + 1)}`,
      params,
    ),
    q.query(
      `SELECT count(*)::int AS n FROM group_function_quotes q ${whereSql(built.where)}`,
      built.params,
    ),
    contractCounts(now),
  ]);
  const pageRows = pageRaw as QuoteRowSource[];
  const totalRows = totalRaw as { n: number }[];

  const page = pageRows.slice(0, limit);
  const ctx = await rowContext(page, now);
  const rows = page.map((r) => toContractRow(r, ctx));
  const last = page[page.length - 1];
  const nextCursor =
    pageRows.length > limit && last
      ? encodeContractCursor(String(last.event_date).slice(0, 10), String(last.id))
      : null;

  return {
    rows,
    nextCursor,
    total: Number(totalRows[0]?.n ?? 0) || 0,
    counts,
  };
}

/** One row by short id, projected exactly as the list projects it. */
export async function getContractRow(
  shortId: string,
  now = new Date(),
): Promise<{ row: ContractRow; quote: QuoteRowSource } | null> {
  if (!isDbConfigured()) return null;
  await ensureGfSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${QUOTE_COLUMNS} FROM group_function_quotes q WHERE q.contract_short_id = $1 LIMIT 1`,
    [shortId],
  )) as QuoteRowSource[];
  const quote = rows[0];
  if (!quote) return null;
  const ctx = await rowContext([quote], now);
  return { row: toContractRow(quote, ctx), quote };
}
