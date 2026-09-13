/**
 * `crm_sms_threads` — one conversation per (rep DID, guest number) (brief
 * §3.8). Rep DIDs live in `crm_reps.vox_did` ONLY (R8).
 *
 * ONE PERSON, MANY THREADS. The table is keyed by (rep DID, guest number)
 * because that is what a carrier gives us: an inbound message names the DID it
 * arrived on and nothing else. The Conversations screen shows ONE entry per
 * PERSON, so `service/threads.ts` folds a guest's threads together — this
 * module stays at the carrier's grain and never guesses.
 *
 * C1 adds `stopped_at` with `ADD COLUMN IF NOT EXISTS` inside this sub's own
 * data file, which is the only DDL a post-PR1 change may do (brief §3.8).
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";
import type { SmsThread } from "../types";

let schemaReady: Promise<void> | null = null;

export function ensureSmsThreadsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_sms_threads (
        id BIGSERIAL PRIMARY KEY,
        rep_id BIGINT REFERENCES crm_reps(id),
        rep_did TEXT NOT NULL,
        guest_e164 TEXT NOT NULL,
        contact_id BIGINT,
        lead_id BIGINT,
        last_message_at TIMESTAMPTZ,
        last_inbound_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rep_did, guest_e164)
      )
    `;
    // C1: a STOP on a rep DID stops that conversation, not the whole account.
    // The consent LEDGER (`sms_suppression`) is still the source of truth for
    // whether a number may be texted at all — `voxSend` consults it first; this
    // column is what the thread SHOWS and what the composer refuses on.
    await q`ALTER TABLE crm_sms_threads ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ`;
    await q`CREATE INDEX IF NOT EXISTS crm_sms_threads_guest ON crm_sms_threads (guest_e164)`;
    await q`CREATE INDEX IF NOT EXISTS crm_sms_threads_recent ON crm_sms_threads (last_message_at DESC NULLS LAST)`;
  })();
  return schemaReady;
}

export interface SmsThreadRowRaw {
  id: string;
  rep_id: string | null;
  rep_did: string;
  guest_e164: string;
  contact_id: string | null;
  lead_id: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  read_at: string | null;
  unread_count: number;
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The thread SELECT list, optionally table-qualified (`""` inside a RETURNING). */
export function threadColumns(prefix = "t."): string {
  const c = (name: string) => `${prefix}${name}`;
  return `
  ${c("id")}::text AS id, ${c("rep_id")}::text AS rep_id, ${c("rep_did")}, ${c("guest_e164")},
  ${c("contact_id")}::text AS contact_id, ${c("lead_id")}::text AS lead_id,
  ${ISO(c("last_message_at"))} AS last_message_at,
  ${ISO(c("last_inbound_at"))} AS last_inbound_at,
  ${ISO(c("read_at"))} AS read_at,
  ${c("unread_count")}, ${ISO(c("stopped_at"))} AS stopped_at,
  ${ISO(c("created_at"))} AS created_at, ${ISO(c("updated_at"))} AS updated_at
`;
}

const THREAD_COLUMNS = threadColumns();

export function mapThreadRow(r: SmsThreadRowRaw): SmsThread {
  return {
    id: String(r.id),
    repId: r.rep_id ? String(r.rep_id) : null,
    repDid: r.rep_did,
    guestE164: r.guest_e164,
    contactId: r.contact_id ? String(r.contact_id) : null,
    leadId: r.lead_id ? String(r.lead_id) : null,
    lastMessageAt: r.last_message_at ?? null,
    lastInboundAt: r.last_inbound_at ?? null,
    readAt: r.read_at ?? null,
    unreadCount: typeof r.unread_count === "number" ? r.unread_count : Number(r.unread_count ?? 0),
    stoppedAt: r.stopped_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface ThreadUpsert {
  repId: string | null;
  repDid: string;
  guestE164: string;
  contactId?: string | null;
  leadId?: string | null;
}

/**
 * Find or create the thread for (rep DID, guest). The conflict arm only FILLS
 * blanks — a contact or lead link already on the row is never overwritten by a
 * later guess, and the rep id is healed if the DID has since been claimed.
 */
export async function upsertThread(input: ThreadUpsert): Promise<SmsThread> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureSmsThreadsSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_sms_threads (rep_id, rep_did, guest_e164, contact_id, lead_id)
     VALUES ($1::bigint, $2, $3, $4::bigint, $5::bigint)
     ON CONFLICT (rep_did, guest_e164) DO UPDATE SET
       rep_id = COALESCE(crm_sms_threads.rep_id, EXCLUDED.rep_id),
       contact_id = COALESCE(crm_sms_threads.contact_id, EXCLUDED.contact_id),
       lead_id = COALESCE(crm_sms_threads.lead_id, EXCLUDED.lead_id),
       updated_at = NOW()
     RETURNING ${threadColumns("")}`,
    [input.repId, input.repDid, input.guestE164, input.contactId ?? null, input.leadId ?? null],
  )) as SmsThreadRowRaw[];
  return mapThreadRow(rows[0]);
}

export async function getThread(id: string): Promise<SmsThread | null> {
  if (!isDbConfigured()) return null;
  await ensureSmsThreadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${THREAD_COLUMNS} FROM crm_sms_threads t WHERE t.id = $1::bigint`,
    [id],
  )) as SmsThreadRowRaw[];
  return rows[0] ? mapThreadRow(rows[0]) : null;
}

/** Every thread for one guest number, newest activity first. */
export async function threadsForGuest(guestE164: string): Promise<SmsThread[]> {
  if (!isDbConfigured()) return [];
  await ensureSmsThreadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${THREAD_COLUMNS} FROM crm_sms_threads t
      WHERE t.guest_e164 = $1
      ORDER BY t.last_message_at DESC NULLS LAST, t.id DESC`,
    [guestE164],
  )) as SmsThreadRowRaw[];
  return rows.map(mapThreadRow);
}

/** Every thread for one contact id, across reps. */
export async function threadsForContact(contactId: string): Promise<SmsThread[]> {
  if (!isDbConfigured()) return [];
  await ensureSmsThreadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${THREAD_COLUMNS} FROM crm_sms_threads t
      WHERE t.contact_id = $1::bigint
      ORDER BY t.last_message_at DESC NULLS LAST, t.id DESC`,
    [contactId],
  )) as SmsThreadRowRaw[];
  return rows.map(mapThreadRow);
}

export const THREAD_LIST_MAX = 200;

export interface ThreadListFilter {
  /** Only this rep's own threads; a director passes nothing and sees the team. */
  repId?: string | null;
  limit?: number;
  /** Keyset: rows strictly older than this instant. */
  before?: string | null;
  unreadOnly?: boolean;
}

/**
 * The Conversations list at the thread grain, newest first, keyset on
 * `last_message_at` (R10: never OFFSET). `service/threads.ts` folds the page
 * into one entry per person.
 */
export async function listThreads(filter: ThreadListFilter = {}): Promise<SmsThread[]> {
  if (!isDbConfigured()) return [];
  await ensureSmsThreadsSchema();
  const q = sql();
  const limit = Math.max(1, Math.min(filter.limit ?? 50, THREAD_LIST_MAX));
  const rows = (await q.query(
    `SELECT ${THREAD_COLUMNS} FROM crm_sms_threads t
      WHERE ($1::bigint IS NULL OR t.rep_id = $1::bigint)
        AND ($2::timestamptz IS NULL OR t.last_message_at < $2::timestamptz)
        AND (NOT $3::boolean OR t.unread_count > 0)
        AND t.last_message_at IS NOT NULL
      ORDER BY t.last_message_at DESC, t.id DESC
      LIMIT $4`,
    [filter.repId ?? null, filter.before ?? null, filter.unreadOnly === true, limit],
  )) as SmsThreadRowRaw[];
  return rows.map(mapThreadRow);
}

/** Sum of unread counts, for the sidebar badge. A rep sees only their own. */
export async function unreadTotal(repId: string | null): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureSmsThreadsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT COALESCE(SUM(unread_count), 0)::int AS n FROM crm_sms_threads
      WHERE ($1::bigint IS NULL OR rep_id = $1::bigint)`,
    [repId],
  )) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/** An OUTBOUND message landed: bump the clock, never the unread count. */
export async function markOutbound(threadId: string, at: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSmsThreadsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_sms_threads
        SET last_message_at = GREATEST(COALESCE(last_message_at, $2::timestamptz), $2::timestamptz),
            updated_at = NOW()
      WHERE id = $1::bigint`,
    [threadId, at],
  );
}

/** An INBOUND message landed: bump the clock and the unread count. */
export async function markInbound(threadId: string, at: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSmsThreadsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_sms_threads
        SET last_message_at = GREATEST(COALESCE(last_message_at, $2::timestamptz), $2::timestamptz),
            last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2::timestamptz), $2::timestamptz),
            unread_count = unread_count + 1,
            updated_at = NOW()
      WHERE id = $1::bigint`,
    [threadId, at],
  );
}

/** The rep opened the conversation. */
export async function markThreadsRead(threadIds: readonly string[]): Promise<void> {
  if (!isDbConfigured() || threadIds.length === 0) return;
  await ensureSmsThreadsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_sms_threads
        SET unread_count = 0, read_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1::bigint[])`,
    [threadIds],
  );
}

/** STOP sets the stamp; START clears it. */
export async function setThreadStopped(threadId: string, stopped: boolean): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSmsThreadsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_sms_threads
        SET stopped_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END, updated_at = NOW()
      WHERE id = $1::bigint`,
    [threadId, stopped],
  );
}

/** Attach a contact / lead to a thread once we learn who the number belongs to. */
export async function linkThread(
  threadId: string,
  link: { contactId?: string | null; leadId?: string | null },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSmsThreadsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_sms_threads
        SET contact_id = COALESCE(contact_id, $2::bigint),
            lead_id = COALESCE($3::bigint, lead_id),
            updated_at = NOW()
      WHERE id = $1::bigint`,
    [threadId, link.contactId ?? null, link.leadId ?? null],
  );
}
