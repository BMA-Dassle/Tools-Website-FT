/**
 * `crm_leads` — the pipeline row (brief §3.8). Neon FIRST: `capture_payload`
 * keeps the raw guest submission on every row (R2) and every BMI id is TEXT.
 *
 * DDL is PR1's; B3 adds `kids` (ADD COLUMN IF NOT EXISTS — the one column the
 * mint policy needs: a birthday goes to Pandora as "Child Birthday" only when
 * the lead is a kids' party) and the readers / writers.
 *
 * `status_id` references `crm_statuses` with DEFAULT 'new', so the statuses
 * seed must exist before the first lead — `ensureCrmSchema()` seeds lazily.
 *
 * READ SHAPE. Every reader returns `LeadView` (the wire type): the lead row
 * joined to its contact, account and assignee so a card never needs a second
 * round trip. Dates leave Neon as text (`to_char`) so a `DATE` column is never
 * turned into a local-midnight `Date` by the driver (R10) and a `TIMESTAMPTZ`
 * is always an ISO instant.
 *
 * PUBLIC ID. `public_id` is `'L-' || id`, minted in the same INSERT through
 * `nextval()` so it is unique by construction and never a two-step race.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";
import { ensureStatusesSchema } from "~/features/crm/statuses";
import type { CentreCode, EventType, LeadSource, MintStatus, NextAction } from "../../core/types";
import type { LeadView } from "../contracts";
import { ensureAccountsSchema } from "./accounts-db";
import { ensureContactsSchema } from "./contacts-db";

let schemaReady: Promise<void> | null = null;

export function ensureLeadsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    await ensureStatusesSchema();
    await ensureAccountsSchema();
    await ensureContactsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_leads (
        id BIGSERIAL PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        contact_id BIGINT REFERENCES crm_contacts(id),
        account_id BIGINT REFERENCES crm_accounts(id),
        centre TEXT NOT NULL,
        event_date DATE NOT NULL,
        event_time TIME,
        guests INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        is_prospect BOOLEAN NOT NULL DEFAULT FALSE,
        status_id TEXT NOT NULL REFERENCES crm_statuses(id) DEFAULT 'new',
        assigned_rep_id BIGINT REFERENCES crm_reps(id),
        assigned_at TIMESTAMPTZ,
        held_for_rep_id BIGINT REFERENCES crm_reps(id),
        first_touch_at TIMESTAMPTZ,
        next_action_kind TEXT,
        next_action_due TIMESTAMPTZ,
        next_action_label TEXT,
        value_cents BIGINT NOT NULL DEFAULT 0,
        lost_reason TEXT,
        notes TEXT,
        bmi_project_id TEXT,
        bmi_project_number TEXT,
        bmi_state_id TEXT,
        bmi_state_name TEXT,
        bmi_person_id TEXT,
        bmi_synced_at TIMESTAMPTZ,
        mint_status TEXT NOT NULL DEFAULT 'none' CHECK (mint_status IN ('none','pending','minted','failed')),
        mint_error TEXT,
        mint_attempts INTEGER NOT NULL DEFAULT 0,
        gf_short_id TEXT,
        last_year_bmi_project_id TEXT,
        cold_row_id BIGINT,
        capture_payload JSONB NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at TIMESTAMPTZ
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_leads_open ON crm_leads (status_id, assigned_rep_id, event_date)`;
    await q`CREATE INDEX IF NOT EXISTS crm_leads_bmi ON crm_leads (bmi_project_id)`;
    await q`
      CREATE INDEX IF NOT EXISTS crm_leads_queue ON crm_leads (created_at)
      WHERE assigned_rep_id IS NULL AND archived_at IS NULL
    `;
    // B3: the kids flag (mint policy + rule R2). Own sub, ADD COLUMN IF NOT EXISTS only.
    await q`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS kids BOOLEAN NOT NULL DEFAULT FALSE`;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Row shape and mapping
// ---------------------------------------------------------------------------

/** A joined `crm_leads` row as `LEAD_SELECT` returns it. */
export interface LeadRowRaw {
  id: string;
  public_id: string;
  contact_id: string | null;
  account_id: string | null;
  centre: string;
  event_date: string;
  event_time: string | null;
  guests: number;
  event_type: string;
  source: string;
  is_prospect: boolean;
  kids: boolean;
  status_id: string;
  assigned_rep_id: string | null;
  assigned_at: string | null;
  held_for_rep_id: string | null;
  first_touch_at: string | null;
  next_action_kind: string | null;
  next_action_due: string | null;
  next_action_label: string | null;
  value_cents: string | number;
  lost_reason: string | null;
  notes: string | null;
  bmi_project_id: string | null;
  bmi_project_number: string | null;
  bmi_state_id: string | null;
  bmi_state_name: string | null;
  bmi_person_id: string | null;
  bmi_synced_at: string | null;
  mint_status: string;
  mint_error: string | null;
  mint_attempts: number;
  gf_short_id: string | null;
  last_year_bmi_project_id: string | null;
  cold_row_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  c_first_name: string | null;
  c_last_name: string | null;
  c_phone_e164: string | null;
  c_email: string | null;
  c_prefers: string | null;
  a_name: string | null;
  r_slug: string | null;
  r_display_name: string | null;
}

const MINT_STATUSES = new Set<MintStatus>(["none", "pending", "minted", "failed"]);
const PREFERS = new Set(["text", "call", "email"]);

export function mapLeadRow(r: LeadRowRaw): LeadView {
  const nextAction: NextAction | null = r.next_action_due
    ? {
        kind: r.next_action_kind ?? "call",
        due: r.next_action_due,
        label: r.next_action_label ?? null,
      }
    : null;
  return {
    id: String(r.id),
    publicId: r.public_id,
    contactId: r.contact_id ? String(r.contact_id) : null,
    accountId: r.account_id ? String(r.account_id) : null,
    centre: r.centre as CentreCode,
    eventDate: r.event_date,
    eventTime: r.event_time ? r.event_time.slice(0, 5) : null,
    guests: Number(r.guests) || 0,
    type: r.event_type as EventType,
    source: r.source as LeadSource,
    isProspect: r.is_prospect === true,
    status: r.status_id,
    rep: r.assigned_rep_id ? String(r.assigned_rep_id) : null,
    assignedAt: r.assigned_at ?? null,
    heldForRep: r.held_for_rep_id ? String(r.held_for_rep_id) : null,
    firstTouchAt: r.first_touch_at ?? null,
    nextAction,
    valueCents: Number(r.value_cents) || 0,
    lostReason: r.lost_reason ?? null,
    notes: r.notes ?? null,
    bmi: {
      projectId: r.bmi_project_id ?? null,
      projectNumber: r.bmi_project_number ?? null,
      stateId: r.bmi_state_id ?? null,
      stateName: r.bmi_state_name ?? null,
      personId: r.bmi_person_id ?? null,
      syncedAt: r.bmi_synced_at ?? null,
    },
    mintStatus: MINT_STATUSES.has(r.mint_status as MintStatus)
      ? (r.mint_status as MintStatus)
      : "none",
    mintError: r.mint_error ?? null,
    mintAttempts: Number(r.mint_attempts) || 0,
    gfShortId: r.gf_short_id ?? null,
    lastYearBmiProjectId: r.last_year_bmi_project_id ?? null,
    coldRowId: r.cold_row_id ? String(r.cold_row_id) : null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at ?? null,
    kids: r.kids === true,
    guest: {
      first: r.c_first_name ?? "",
      last: r.c_last_name ?? "",
      phone: r.c_phone_e164 ?? null,
      email: r.c_email ?? null,
      company: r.a_name ?? null,
      prefers: PREFERS.has(r.c_prefers ?? "") ? (r.c_prefers as "text" | "call" | "email") : null,
    },
    repSlug: r.r_slug ?? null,
    repName: r.r_display_name ?? null,
  };
}

/** `TIMESTAMPTZ` → ISO-8601 UTC text, so `new Date()` on the client is exact. */
const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const LEAD_SELECT = `
  l.id::text AS id, l.public_id, l.contact_id::text AS contact_id, l.account_id::text AS account_id,
  l.centre, to_char(l.event_date, 'YYYY-MM-DD') AS event_date, to_char(l.event_time, 'HH24:MI') AS event_time,
  l.guests, l.event_type, l.source, l.is_prospect, l.kids, l.status_id,
  l.assigned_rep_id::text AS assigned_rep_id, ${ISO("l.assigned_at")} AS assigned_at,
  l.held_for_rep_id::text AS held_for_rep_id, ${ISO("l.first_touch_at")} AS first_touch_at,
  l.next_action_kind, ${ISO("l.next_action_due")} AS next_action_due, l.next_action_label,
  l.value_cents::text AS value_cents, l.lost_reason, l.notes,
  l.bmi_project_id, l.bmi_project_number, l.bmi_state_id, l.bmi_state_name, l.bmi_person_id,
  ${ISO("l.bmi_synced_at")} AS bmi_synced_at,
  l.mint_status, l.mint_error, l.mint_attempts, l.gf_short_id, l.last_year_bmi_project_id,
  l.cold_row_id::text AS cold_row_id, l.created_by,
  ${ISO("l.created_at")} AS created_at, ${ISO("l.updated_at")} AS updated_at, ${ISO("l.archived_at")} AS archived_at,
  c.first_name AS c_first_name, c.last_name AS c_last_name, c.phone_e164 AS c_phone_e164,
  c.email AS c_email, c.prefers AS c_prefers,
  a.name AS a_name, r.slug AS r_slug, r.display_name AS r_display_name
`;

export const LEAD_FROM = `
  FROM crm_leads l
  LEFT JOIN crm_contacts c ON c.id = l.contact_id
  LEFT JOIN crm_accounts a ON a.id = l.account_id
  LEFT JOIN crm_reps r ON r.id = l.assigned_rep_id
`;

/** `L-123` or `123` → `123`; anything else → null. */
export function leadNumericId(idOrPublic: string): string | null {
  const m = /^(?:L-)?(\d{1,18})$/.exec(idOrPublic.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export interface NewLeadRow {
  contactId: string | null;
  accountId: string | null;
  centre: CentreCode;
  eventDate: string;
  eventTime: string | null;
  guests: number;
  type: EventType;
  source: LeadSource;
  isProspect: boolean;
  kids: boolean;
  notes: string | null;
  mintStatus: MintStatus;
  mintError: string | null;
  capturePayload: Record<string, unknown>;
  createdBy: string | null;
}

/** INSERT with `public_id = 'L-' || id` minted in the same statement. Returns the id. */
export async function insertLead(row: NewLeadRow): Promise<string> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `WITH n AS (SELECT nextval(pg_get_serial_sequence('crm_leads', 'id')) AS id)
     INSERT INTO crm_leads (id, public_id, contact_id, account_id, centre, event_date, event_time, guests,
                            event_type, source, is_prospect, kids, notes, mint_status, mint_error,
                            capture_payload, created_by)
     SELECT n.id, 'L-' || n.id::text, $1::bigint, $2::bigint, $3, $4::date, $5::time, $6::int,
            $7, $8, $9::boolean, $10::boolean, $11, $12, $13, $14::jsonb, $15
       FROM n
     RETURNING id::text AS id`,
    [
      row.contactId,
      row.accountId,
      row.centre,
      row.eventDate,
      row.eventTime,
      row.guests,
      row.type,
      row.source,
      row.isProspect,
      row.kids,
      row.notes,
      row.mintStatus,
      row.mintError,
      JSON.stringify(row.capturePayload ?? {}),
      row.createdBy,
    ],
  )) as { id: string }[];
  if (!rows[0]) throw new Error("crm_leads: insert returned no row");
  return String(rows[0].id);
}

/** Columns a service may patch, keyed by the camelCase name it uses. */
export const LEAD_PATCHABLE = {
  contactId: "contact_id",
  accountId: "account_id",
  eventDate: "event_date",
  eventTime: "event_time",
  guests: "guests",
  type: "event_type",
  kids: "kids",
  notes: "notes",
  valueCents: "value_cents",
  statusId: "status_id",
  assignedRepId: "assigned_rep_id",
  assignedAt: "assigned_at",
  heldForRepId: "held_for_rep_id",
  firstTouchAt: "first_touch_at",
  nextActionKind: "next_action_kind",
  nextActionDue: "next_action_due",
  nextActionLabel: "next_action_label",
  lostReason: "lost_reason",
  bmiProjectId: "bmi_project_id",
  bmiProjectNumber: "bmi_project_number",
  bmiStateId: "bmi_state_id",
  bmiStateName: "bmi_state_name",
  bmiPersonId: "bmi_person_id",
  bmiSyncedAt: "bmi_synced_at",
  mintStatus: "mint_status",
  mintError: "mint_error",
  mintAttempts: "mint_attempts",
  archivedAt: "archived_at",
} as const;

export type LeadPatch = Partial<Record<keyof typeof LEAD_PATCHABLE, unknown>>;

/** Build `SET a = $1, b = $2` from a patch; unknown keys are refused, never interpolated. */
export function buildLeadSet(patch: LeadPatch): { set: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = LEAD_PATCHABLE[key as keyof typeof LEAD_PATCHABLE];
    if (!col) throw new Error(`crm_leads: cannot patch ${key}`);
    if (value === undefined) continue;
    params.push(value instanceof Date ? value.toISOString() : value);
    parts.push(`${col} = $${params.length}`);
  }
  if (parts.length === 0) throw new Error("crm_leads: empty patch");
  parts.push("updated_at = NOW()");
  return { set: parts.join(", "), params };
}

export async function updateLeadFields(id: string, patch: LeadPatch): Promise<LeadView | null> {
  if (!isDbConfigured()) return null;
  await ensureLeadsSchema();
  const { set, params } = buildLeadSet(patch);
  const q = sql();
  await q.query(`UPDATE crm_leads SET ${set} WHERE id = $${params.length + 1}::bigint`, [
    ...params,
    id,
  ]);
  return getLead(id);
}

/** `mint_attempts + 1` in SQL (never read-modify-write) plus the outcome fields. */
export async function bumpMintAttempt(
  id: string,
  patch: Pick<LeadPatch, "mintStatus" | "mintError">,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureLeadsSchema();
  const q = sql();
  await q`
    UPDATE crm_leads
       SET mint_attempts = mint_attempts + 1,
           mint_status = COALESCE(${(patch.mintStatus as string | undefined) ?? null}, mint_status),
           mint_error = ${(patch.mintError as string | null | undefined) ?? null},
           updated_at = NOW()
     WHERE id = ${id}::bigint
  `;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export async function getLead(idOrPublic: string): Promise<LeadView | null> {
  const id = leadNumericId(idOrPublic);
  if (!id || !isDbConfigured()) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${LEAD_SELECT} ${LEAD_FROM} WHERE l.id = $1::bigint`, [
    id,
  ])) as LeadRowRaw[];
  return rows[0] ? mapLeadRow(rows[0]) : null;
}

export interface LeadListFilter {
  cursor?: string | null;
  limit?: number;
  statusId?: string;
  repId?: string;
  centre?: CentreCode;
  q?: string;
  unassigned?: boolean;
  includeArchived?: boolean;
}

export interface LeadListPage {
  leads: LeadView[];
  nextCursor: string | null;
}

/** `<createdAtIso>|<id>` ⇄ opaque base64url. */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(
  cursor: string | null | undefined,
): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const bar = raw.lastIndexOf("|");
    if (bar < 0) return null;
    const createdAt = raw.slice(0, bar);
    const id = raw.slice(bar + 1);
    if (!/^\d{1,18}$/.test(id) || Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export const LEAD_LIST_MAX = 200;
export const LEAD_LIST_DEFAULT = 50;

/** Keyset on (created_at DESC, id DESC); `limit ≤ 200` (R10). */
export async function listLeads(filter: LeadListFilter = {}): Promise<LeadListPage> {
  if (!isDbConfigured()) return { leads: [], nextCursor: null };
  await ensureLeadsSchema();
  const limit = Math.min(Math.max(filter.limit ?? LEAD_LIST_DEFAULT, 1), LEAD_LIST_MAX);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (!filter.includeArchived) where.push("l.archived_at IS NULL");
  if (filter.statusId) where.push(`l.status_id = ${add(filter.statusId)}`);
  if (filter.repId) where.push(`l.assigned_rep_id = ${add(filter.repId)}::bigint`);
  if (filter.unassigned) where.push("l.assigned_rep_id IS NULL");
  if (filter.centre) where.push(`l.centre = ${add(filter.centre)}`);
  if (filter.q) {
    const like = add(`%${filter.q}%`);
    const digits = filter.q.replace(/\D/g, "");
    const digitsClause = digits.length >= 4 ? ` OR c.phone_e164 LIKE ${add(`%${digits}%`)}` : "";
    where.push(
      `(l.public_id ILIKE ${like} OR c.first_name ILIKE ${like} OR c.last_name ILIKE ${like}` +
        ` OR a.name ILIKE ${like} OR c.email ILIKE ${like} OR l.bmi_project_number ILIKE ${like}${digitsClause})`,
    );
  }
  const cur = decodeCursor(filter.cursor);
  if (cur) {
    where.push(
      `(l.created_at, l.id) < (${add(cur.createdAt)}::timestamptz, ${add(cur.id)}::bigint)`,
    );
  }
  const q = sql();
  const rows = (await q.query(
    `SELECT ${LEAD_SELECT} ${LEAD_FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ${add(limit + 1)}`,
    params,
  )) as LeadRowRaw[];
  const page = rows.slice(0, limit).map(mapLeadRow);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
  return { leads: page, nextCursor };
}

/** Unassigned, live, open — oldest first (the queue's order). */
export async function listUnassignedLeads(limit = LEAD_LIST_MAX): Promise<LeadView[]> {
  if (!isDbConfigured()) return [];
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${LEAD_SELECT} ${LEAD_FROM}
       JOIN crm_statuses s ON s.id = l.status_id
      WHERE l.assigned_rep_id IS NULL AND l.archived_at IS NULL AND s.kind = 'open'
      ORDER BY l.created_at ASC, l.id ASC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), LEAD_LIST_MAX)],
  )) as LeadRowRaw[];
  return rows.map(mapLeadRow);
}

export async function countUnassignedLeads(): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q`
    SELECT count(*)::int AS n
      FROM crm_leads l JOIN crm_statuses s ON s.id = l.status_id
     WHERE l.assigned_rep_id IS NULL AND l.archived_at IS NULL AND s.kind = 'open'
  `) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/** Leads in `assigned` (handed over, no touch yet) — per rep when given. */
export async function listAssignedAwaitingTouch(repId?: string | null): Promise<LeadView[]> {
  if (!isDbConfigured()) return [];
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${LEAD_SELECT} ${LEAD_FROM}
      WHERE l.status_id = 'assigned' AND l.archived_at IS NULL AND l.assigned_rep_id IS NOT NULL
        AND ($1::bigint IS NULL OR l.assigned_rep_id = $1::bigint)
      ORDER BY l.assigned_at ASC NULLS LAST, l.id ASC
      LIMIT ${LEAD_LIST_MAX}`,
    [repId ?? null],
  )) as LeadRowRaw[];
  return rows.map(mapLeadRow);
}

/** Open leads with a next action, soonest first — per rep or the whole team. */
export async function listDueLeads(repId?: string | null): Promise<LeadView[]> {
  if (!isDbConfigured()) return [];
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${LEAD_SELECT} ${LEAD_FROM}
       JOIN crm_statuses s ON s.id = l.status_id
      WHERE l.next_action_due IS NOT NULL AND l.archived_at IS NULL AND s.kind = 'open'
        AND l.assigned_rep_id IS NOT NULL
        AND ($1::bigint IS NULL OR l.assigned_rep_id = $1::bigint)
      ORDER BY l.next_action_due ASC, l.id ASC
      LIMIT ${LEAD_LIST_MAX}`,
    [repId ?? null],
  )) as LeadRowRaw[];
  return rows.map(mapLeadRow);
}

export async function countLeadsInStatus(statusId: string): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q`
    SELECT count(*)::int AS n FROM crm_leads WHERE status_id = ${statusId} AND archived_at IS NULL
  `) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

export interface VolumeRow {
  repId: string;
  /** "2026-10" */
  month: string;
  guests: number;
  count: number;
}

/** Open volume per assignee per party month — what the standard rule balances on. */
export async function volumeByRepMonth(months: readonly string[]): Promise<VolumeRow[]> {
  if (!isDbConfigured() || months.length === 0) return [];
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT l.assigned_rep_id::text AS rep_id, to_char(l.event_date, 'YYYY-MM') AS month,
            COALESCE(sum(l.guests), 0)::int AS guests, count(*)::int AS count
       FROM crm_leads l JOIN crm_statuses s ON s.id = l.status_id
      WHERE l.assigned_rep_id IS NOT NULL AND l.archived_at IS NULL AND s.kind = 'open'
        AND to_char(l.event_date, 'YYYY-MM') = ANY($1::text[])
      GROUP BY 1, 2`,
    [Array.from(months)],
  )) as { rep_id: string; month: string; guests: number; count: number }[];
  return rows.map((r) => ({
    repId: String(r.rep_id),
    month: r.month,
    guests: Number(r.guests) || 0,
    count: Number(r.count) || 0,
  }));
}

/**
 * A lead for the same guest, centre and event date captured in the last
 * `withinMinutes` — a form resubmitted after a Pandora failure must not become
 * a second row (the first one already holds the capture, R2).
 */
export async function findRecentDuplicateLead(input: {
  phoneE164: string | null;
  emailKey: string | null;
  centre: CentreCode;
  eventDate: string;
  withinMinutes?: number;
}): Promise<LeadView | null> {
  if (!isDbConfigured()) return null;
  if (!input.phoneE164 && !input.emailKey) return null;
  await ensureLeadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${LEAD_SELECT} ${LEAD_FROM}
      WHERE l.centre = $1 AND l.event_date = $2::date AND l.archived_at IS NULL
        AND l.created_at > NOW() - make_interval(mins => $5)
        AND (($3::text IS NOT NULL AND c.phone_e164 = $3) OR ($4::text IS NOT NULL AND c.email_key = $4))
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 1`,
    [input.centre, input.eventDate, input.phoneE164, input.emailKey, input.withinMinutes ?? 15],
  )) as LeadRowRaw[];
  return rows[0] ? mapLeadRow(rows[0]) : null;
}
