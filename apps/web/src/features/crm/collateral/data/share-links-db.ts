/**
 * `crm_share_links` — a tokenised guest link to one collateral item (brief
 * §3.8), served by the PUBLIC `app/api/crm/share/[token]` route (C6).
 *
 * DDL is PR1's. C6 adds — ADD COLUMN IF NOT EXISTS only —
 *   created_by      the rep who made the link (actor_email; R9)
 *   last_opened_at  the most recent real open
 *   last_open_key   a hash of viewer + minute, so a double-tap or a mail
 *                   client's pre-fetch counts ONCE per viewer-minute
 *   expired_at      set by the `share-link-expire` sweep or a revoke; the
 *                   public route answers 410 for it even before `expires_at`
 *
 * The public route reads through `getShareLinkForOpen` (one SELECT joined to
 * the collateral row) and records through `recordShareOpen` (one UPDATE). No
 * DDL runs on the guest path unless the table is missing, which cannot be the
 * case for a link a rep created a moment ago.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { ShareChannel, ShareLink } from "../contracts";
import { ensureCollateralSchema } from "./collateral-db";

let schemaReady: Promise<void> | null = null;

export function ensureShareLinksSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureCollateralSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_share_links (
        token TEXT PRIMARY KEY,
        collateral_id BIGINT NOT NULL REFERENCES crm_collateral(id),
        lead_id BIGINT,
        contact_id BIGINT,
        rep_id BIGINT,
        channel TEXT,
        opened_at TIMESTAMPTZ,
        open_count INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`ALTER TABLE crm_share_links ADD COLUMN IF NOT EXISTS created_by TEXT`;
    await q`ALTER TABLE crm_share_links ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ`;
    await q`ALTER TABLE crm_share_links ADD COLUMN IF NOT EXISTS last_open_key TEXT`;
    await q`ALTER TABLE crm_share_links ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ`;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface ShareLinkRowRaw {
  token: string;
  collateral_id: string;
  lead_id: string | null;
  contact_id: string | null;
  rep_id: string | null;
  channel: string | null;
  opened_at: string | null;
  last_opened_at: string | null;
  open_count: number | string;
  expires_at: string | null;
  expired_at: string | null;
  created_by: string | null;
  created_at: string;
}

const CHANNELS = new Set<ShareChannel>(["link", "sms", "email"]);

/** `url` is filled by the service (it knows the origin); the row has none. */
export function mapShareLinkRow(r: ShareLinkRowRaw, url: string): ShareLink {
  return {
    token: r.token,
    url,
    collateralId: String(r.collateral_id),
    leadId: r.lead_id === null || r.lead_id === undefined ? null : String(r.lead_id),
    contactId: r.contact_id === null || r.contact_id === undefined ? null : String(r.contact_id),
    repId: r.rep_id === null || r.rep_id === undefined ? null : String(r.rep_id),
    channel: CHANNELS.has(r.channel as ShareChannel) ? (r.channel as ShareChannel) : null,
    openedAt: r.opened_at ?? null,
    lastOpenedAt: r.last_opened_at ?? null,
    openCount: Number(r.open_count) || 0,
    expiresAt: r.expires_at ?? null,
    expiredAt: r.expired_at ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  };
}

const COLUMNS = `
  s.token, s.collateral_id::text AS collateral_id, s.lead_id::text AS lead_id,
  s.contact_id::text AS contact_id, s.rep_id::text AS rep_id, s.channel,
  s.opened_at::text AS opened_at, s.last_opened_at::text AS last_opened_at, s.open_count,
  s.expires_at::text AS expires_at, s.expired_at::text AS expired_at, s.created_by,
  s.created_at::text AS created_at
`;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface ShareLinkInsert {
  token: string;
  collateralId: string;
  leadId: string | null;
  contactId: string | null;
  repId: string | null;
  channel: ShareChannel;
  expiresAt: Date | null;
  createdBy: string;
}

export async function insertShareLink(input: ShareLinkInsert): Promise<ShareLinkRowRaw> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureShareLinksSchema();
  const q = sql();
  const rows = (await q.query(
    `WITH ins AS (
       INSERT INTO crm_share_links
         (token, collateral_id, lead_id, contact_id, rep_id, channel, expires_at, created_by)
       VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6, $7::timestamptz, $8)
       RETURNING *
     )
     SELECT ${COLUMNS} FROM ins s`,
    [
      input.token,
      input.collateralId,
      input.leadId,
      input.contactId,
      input.repId,
      input.channel,
      input.expiresAt ? input.expiresAt.toISOString() : null,
      input.createdBy,
    ],
  )) as ShareLinkRowRaw[];
  return rows[0];
}

/** What the public route needs in ONE read: the link plus its file. */
export interface ShareLinkForOpen extends ShareLinkRowRaw {
  blob_url: string;
  title: string;
  collateral_archived_at: string | null;
  last_open_key: string | null;
}

export async function getShareLinkForOpen(token: string): Promise<ShareLinkForOpen | null> {
  if (!isDbConfigured()) return null;
  await ensureShareLinksSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS}, s.last_open_key, c.blob_url, c.title,
            c.archived_at::text AS collateral_archived_at
       FROM crm_share_links s
       JOIN crm_collateral c ON c.id = s.collateral_id
      WHERE s.token = $1`,
    [token],
  )) as ShareLinkForOpen[];
  return rows[0] ?? null;
}

/**
 * Count an open ONCE per viewer-minute: `open_count` moves only when
 * `last_open_key` differs from the key the route computed. `opened_at` is the
 * first real open and never moves; `last_opened_at` always does.
 */
export async function recordShareOpen(token: string, openKey: string): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureShareLinksSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_share_links SET
       open_count = open_count + CASE WHEN last_open_key IS DISTINCT FROM $2 THEN 1 ELSE 0 END,
       opened_at = COALESCE(opened_at, NOW()),
       last_opened_at = NOW(),
       last_open_key = $2
     WHERE token = $1
     RETURNING open_count`,
    [token, openKey],
  )) as { open_count: number | string }[];
  return rows[0] ? Number(rows[0].open_count) || 0 : 0;
}

/** The sweep: mark every link past `expires_at` that is not marked yet. Returns how many. */
export async function expireDueShareLinks(now: Date): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureShareLinksSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_share_links SET expired_at = $1::timestamptz
      WHERE expired_at IS NULL AND expires_at IS NOT NULL AND expires_at < $1::timestamptz
      RETURNING token`,
    [now.toISOString()],
  )) as { token: string }[];
  return rows.length;
}

/** A rep pulls a link back: 410 from now on. Returns false when the token is unknown. */
export async function revokeShareLink(token: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureShareLinksSchema();
  const q = sql();
  const rows = (await q`
    UPDATE crm_share_links SET expired_at = COALESCE(expired_at, NOW())
     WHERE token = ${token}
     RETURNING token
  `) as { token: string }[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Reads for the sheets
// ---------------------------------------------------------------------------

export interface ShareLinkListFilter {
  collateralId?: string | null;
  leadId?: string | null;
  limit?: number | null;
}

/** Newest first; at least one of the filters is expected (the route enforces it). */
export async function listShareLinks(filter: ShareLinkListFilter): Promise<ShareLinkRowRaw[]> {
  if (!isDbConfigured()) return [];
  await ensureShareLinksSchema();
  const q = sql();
  const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
  return (await q.query(
    `SELECT ${COLUMNS}
       FROM crm_share_links s
      WHERE ($1::bigint IS NULL OR s.collateral_id = $1::bigint)
        AND ($2::bigint IS NULL OR s.lead_id = $2::bigint)
      ORDER BY s.created_at DESC, s.token ASC
      LIMIT $3`,
    [filter.collateralId ?? null, filter.leadId ?? null, limit],
  )) as ShareLinkRowRaw[];
}

export async function getShareLink(token: string): Promise<ShareLinkRowRaw | null> {
  if (!isDbConfigured()) return null;
  await ensureShareLinksSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_share_links s WHERE s.token = $1`, [
    token,
  ])) as ShareLinkRowRaw[];
  return rows[0] ?? null;
}
