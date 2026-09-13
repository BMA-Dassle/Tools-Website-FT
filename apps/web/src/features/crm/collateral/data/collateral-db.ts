/**
 * `crm_collateral` — the files reps share (brief §3.8); bytes live in Vercel
 * Blob (or at any public URL the owner points at), the row carries the URL and
 * the metadata: title, centre, type, tags, season validity, share count.
 *
 * DDL is PR1's. C6 adds — per the ownership rule, ADD COLUMN IF NOT EXISTS
 * only — `content_type`, `blob_pathname` and `updated_by`, and the readers /
 * writers below. Pagination is keyset on `(created_at, id)` (R10): the cursor
 * is an opaque base64 of `created_at|id`, `limit ≤ 200`.
 *
 * Ids leave this module as STRINGS (`id::text`); `size_bytes` is a BIGINT the
 * driver returns as text, so it is `Number()`ed here — it is a byte count, not
 * a BMI id.
 */

import { isDbConfigured, sql } from "@ft/db";
import { isCentreCode } from "../../core/centres";
import type { CentreCode } from "../../core/types";
import { COLLATERAL_TYPES, type CollateralItem, type CollateralType } from "../contracts";

let schemaReady: Promise<void> | null = null;

export function ensureCollateralSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_collateral (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        centre TEXT,
        type TEXT NOT NULL,
        blob_url TEXT NOT NULL,
        size_bytes BIGINT,
        tags TEXT[] NOT NULL DEFAULT '{}',
        valid_from DATE,
        valid_until DATE,
        shares INTEGER NOT NULL DEFAULT 0,
        uploaded_by TEXT,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // C6 columns — additive only (brief §4 "Shared files": ADD COLUMN IF NOT EXISTS in the owning sub).
    await q`ALTER TABLE crm_collateral ADD COLUMN IF NOT EXISTS content_type TEXT`;
    await q`ALTER TABLE crm_collateral ADD COLUMN IF NOT EXISTS blob_pathname TEXT`;
    await q`ALTER TABLE crm_collateral ADD COLUMN IF NOT EXISTS updated_by TEXT`;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface CollateralRowRaw {
  id: string;
  title: string;
  centre: string | null;
  type: string;
  blob_url: string;
  blob_pathname: string | null;
  content_type: string | null;
  size_bytes: string | number | null;
  tags: string[] | null;
  valid_from: string | null;
  valid_until: string | null;
  shares: number | string;
  uploaded_by: string | null;
  updated_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const TYPES = new Set<string>(COLLATERAL_TYPES);

export function mapCollateralRow(r: CollateralRowRaw): CollateralItem {
  return {
    id: String(r.id),
    title: r.title,
    centre: isCentreCode(r.centre) ? r.centre : null,
    type: TYPES.has(r.type) ? (r.type as CollateralType) : "FILE",
    blobUrl: r.blob_url,
    blobPathname: r.blob_pathname ?? null,
    contentType: r.content_type ?? null,
    sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === "string") : [],
    validFrom: r.valid_from ?? null,
    validUntil: r.valid_until ?? null,
    shares: Number(r.shares) || 0,
    uploadedBy: r.uploaded_by ?? null,
    updatedBy: r.updated_by ?? null,
    archivedAt: r.archived_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `
  c.id::text AS id, c.title, c.centre, c.type, c.blob_url, c.blob_pathname, c.content_type,
  c.size_bytes::text AS size_bytes, c.tags, c.valid_from::text AS valid_from, c.valid_until::text AS valid_until,
  c.shares, c.uploaded_by, c.updated_by, c.archived_at::text AS archived_at,
  c.created_at::text AS created_at, c.updated_at::text AS updated_at
`;

// ---------------------------------------------------------------------------
// Keyset cursor (pure)
// ---------------------------------------------------------------------------

export const COLLATERAL_MAX_LIMIT = 200;
export const COLLATERAL_DEFAULT_LIMIT = 60;

export interface CollateralCursor {
  createdAt: string;
  id: string;
}

export function encodeCollateralCursor(c: CollateralCursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf8").toString("base64url");
}

export function decodeCollateralCursor(s: string | null | undefined): CollateralCursor | null {
  if (!s) return null;
  try {
    const text = Buffer.from(s, "base64url").toString("utf8");
    const i = text.lastIndexOf("|");
    if (i <= 0) return null;
    const createdAt = text.slice(0, i);
    const id = text.slice(i + 1);
    if (!/^\d{1,18}$/.test(id) || Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function clampLimit(limit: number | null | undefined): number {
  if (!limit || !Number.isFinite(limit)) return COLLATERAL_DEFAULT_LIMIT;
  return Math.max(1, Math.min(COLLATERAL_MAX_LIMIT, Math.floor(limit)));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface CollateralListFilter {
  centre?: CentreCode | null;
  tag?: string | null;
  /** Case-insensitive substring over the title. */
  q?: string | null;
  includeArchived?: boolean;
  /** Hide rows whose `valid_until` is before this ET calendar day (YYYY-MM-DD). */
  hideExpiredBefore?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface CollateralPage {
  items: CollateralItem[];
  nextCursor: string | null;
}

/** Newest first; a centre filter also returns the "every centre" rows (centre IS NULL). */
export async function listCollateral(filter: CollateralListFilter = {}): Promise<CollateralPage> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureCollateralSchema();
  const q = sql();
  const limit = clampLimit(filter.limit);
  const cursor = decodeCollateralCursor(filter.cursor);
  const rows = (await q.query(
    `SELECT ${COLUMNS}
       FROM crm_collateral c
      WHERE ($1::boolean OR c.archived_at IS NULL)
        AND ($2::text IS NULL OR c.centre = $2 OR c.centre IS NULL)
        AND ($3::text IS NULL OR $3 = ANY (c.tags))
        AND ($4::text IS NULL OR c.title ILIKE '%' || $4 || '%')
        AND ($5::date IS NULL OR c.valid_until IS NULL OR c.valid_until >= $5::date)
        AND ($6::timestamptz IS NULL OR (c.created_at, c.id) < ($6::timestamptz, $7::bigint))
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $8`,
    [
      filter.includeArchived === true,
      filter.centre ?? null,
      filter.tag ?? null,
      filter.q?.trim() || null,
      filter.hideExpiredBefore ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  )) as CollateralRowRaw[];
  const page = rows.slice(0, limit).map(mapCollateralRow);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCollateralCursor({ createdAt: last.createdAt, id: last.id })
      : null;
  return { items: page, nextCursor };
}

export async function getCollateral(id: string): Promise<CollateralItem | null> {
  if (!isDbConfigured()) return null;
  await ensureCollateralSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_collateral c WHERE c.id = $1::bigint`, [
    id,
  ])) as CollateralRowRaw[];
  return rows[0] ? mapCollateralRow(rows[0]) : null;
}

/** Distinct tags over live rows, most used first — the folder strip. */
export async function listCollateralTags(): Promise<{ tag: string; n: number }[]> {
  if (!isDbConfigured()) return [];
  await ensureCollateralSchema();
  const q = sql();
  const rows = (await q`
    SELECT t AS tag, count(*)::int AS n
      FROM crm_collateral c, unnest(c.tags) AS t
     WHERE c.archived_at IS NULL
     GROUP BY t
     ORDER BY n DESC, t ASC
     LIMIT 50
  `) as { tag: string; n: number }[];
  return rows.map((r) => ({ tag: r.tag, n: Number(r.n) || 0 }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CollateralCreateInput {
  title: string;
  centre: CentreCode | null;
  type: CollateralType;
  blobUrl: string;
  blobPathname: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  tags: string[];
  validFrom: string | null;
  validUntil: string | null;
  uploadedBy: string;
}

export async function createCollateral(input: CollateralCreateInput): Promise<CollateralItem> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureCollateralSchema();
  const q = sql();
  const rows = (await q.query(
    `WITH ins AS (
       INSERT INTO crm_collateral
         (title, centre, type, blob_url, blob_pathname, content_type, size_bytes, tags,
          valid_from, valid_until, uploaded_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::text[], $9::date, $10::date, $11, $11)
       RETURNING *
     )
     SELECT ${COLUMNS} FROM ins c`,
    [
      input.title,
      input.centre,
      input.type,
      input.blobUrl,
      input.blobPathname,
      input.contentType,
      input.sizeBytes,
      input.tags,
      input.validFrom,
      input.validUntil,
      input.uploadedBy,
    ],
  )) as CollateralRowRaw[];
  return mapCollateralRow(rows[0]);
}

export interface CollateralPatch {
  title?: string;
  centre?: CentreCode | null;
  type?: CollateralType;
  blobUrl?: string;
  tags?: string[];
  validFrom?: string | null;
  validUntil?: string | null;
}

/** Fields left `undefined` keep their value; `null` clears a nullable one. */
export async function updateCollateral(
  id: string,
  patch: CollateralPatch,
  actorEmail: string,
): Promise<CollateralItem | null> {
  if (!isDbConfigured()) return null;
  await ensureCollateralSchema();
  const q = sql();
  const rows = (await q.query(
    `WITH upd AS (
       UPDATE crm_collateral SET
         title = COALESCE($2, title),
         centre = CASE WHEN $3::boolean THEN $4 ELSE centre END,
         type = COALESCE($5, type),
         blob_url = COALESCE($6, blob_url),
         tags = COALESCE($7::text[], tags),
         valid_from = CASE WHEN $8::boolean THEN $9::date ELSE valid_from END,
         valid_until = CASE WHEN $10::boolean THEN $11::date ELSE valid_until END,
         updated_by = $12,
         updated_at = NOW()
       WHERE id = $1::bigint
       RETURNING *
     )
     SELECT ${COLUMNS} FROM upd c`,
    [
      id,
      patch.title ?? null,
      patch.centre !== undefined,
      patch.centre ?? null,
      patch.type ?? null,
      patch.blobUrl ?? null,
      patch.tags ?? null,
      patch.validFrom !== undefined,
      patch.validFrom ?? null,
      patch.validUntil !== undefined,
      patch.validUntil ?? null,
      actorEmail,
    ],
  )) as CollateralRowRaw[];
  return rows[0] ? mapCollateralRow(rows[0]) : null;
}

export async function setCollateralArchived(
  id: string,
  archived: boolean,
  actorEmail: string,
): Promise<CollateralItem | null> {
  if (!isDbConfigured()) return null;
  await ensureCollateralSchema();
  const q = sql();
  const rows = (await q.query(
    `WITH upd AS (
       UPDATE crm_collateral SET
         archived_at = CASE WHEN $2::boolean THEN COALESCE(archived_at, NOW()) ELSE NULL END,
         updated_by = $3, updated_at = NOW()
       WHERE id = $1::bigint
       RETURNING *
     )
     SELECT ${COLUMNS} FROM upd c`,
    [id, archived, actorEmail],
  )) as CollateralRowRaw[];
  return rows[0] ? mapCollateralRow(rows[0]) : null;
}

/** `shares + 1` — called once per share link created. */
export async function bumpCollateralShares(id: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureCollateralSchema();
  const q = sql();
  await q`UPDATE crm_collateral SET shares = shares + 1, updated_at = NOW() WHERE id = ${id}::bigint`;
}
