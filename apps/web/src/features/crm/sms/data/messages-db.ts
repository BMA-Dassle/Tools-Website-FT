/**
 * `crm_sms_messages` — every text, Neon first (R2): the row is `pending`
 * BEFORE `voxSend`, then `sent` / `failed` / `suppressed` with the provider id.
 * `(provider, provider_message_id)` is unique so a replayed status callback or
 * a retried MO cannot double a row.
 *
 * C1 adds `kind` (`sms` | `system`) with `ADD COLUMN IF NOT EXISTS` — a STOP on
 * a rep's DID leaves a visible line in the thread rather than a silent gap, and
 * a system line must never be mistaken for something a rep typed.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { Direction } from "../../core/types";
import type { SmsMessage, SmsMessageKind, SmsSendStatus } from "../types";
import { ensureSmsThreadsSchema } from "./threads-db";

let schemaReady: Promise<void> | null = null;

export function ensureSmsMessagesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureSmsThreadsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_sms_messages (
        id BIGSERIAL PRIMARY KEY,
        thread_id BIGINT NOT NULL REFERENCES crm_sms_threads(id),
        lead_id BIGINT,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        body TEXT NOT NULL,
        sent_from TEXT,
        provider TEXT,
        provider_message_id TEXT,
        delivery_status TEXT,
        delivery_error TEXT,
        send_status TEXT NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending','sent','failed','suppressed','received')),
        fallback_did BOOLEAN NOT NULL DEFAULT FALSE,
        template_id BIGINT,
        actor_email TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`
      ALTER TABLE crm_sms_messages
        ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sms'
    `;
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_sms_messages_provider
      ON crm_sms_messages (provider, provider_message_id)
      WHERE provider_message_id IS NOT NULL
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_sms_messages_thread ON crm_sms_messages (thread_id, occurred_at DESC)`;
  })();
  return schemaReady;
}

export interface SmsMessageRowRaw {
  id: string;
  thread_id: string;
  lead_id: string | null;
  direction: string;
  kind: string | null;
  body: string;
  sent_from: string | null;
  provider: string | null;
  provider_message_id: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  send_status: string;
  fallback_did: boolean;
  template_id: string | null;
  actor_email: string | null;
  occurred_at: string;
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SEND_STATUSES = new Set<SmsSendStatus>([
  "pending",
  "sent",
  "failed",
  "suppressed",
  "received",
]);

export function messageColumns(prefix = ""): string {
  const c = (name: string) => `${prefix}${name}`;
  return `
  ${c("id")}::text AS id, ${c("thread_id")}::text AS thread_id, ${c("lead_id")}::text AS lead_id,
  ${c("direction")}, ${c("kind")}, ${c("body")}, ${c("sent_from")}, ${c("provider")},
  ${c("provider_message_id")}, ${c("delivery_status")}, ${c("delivery_error")},
  ${c("send_status")}, ${c("fallback_did")}, ${c("template_id")}::text AS template_id,
  ${c("actor_email")}, ${ISO(c("occurred_at"))} AS occurred_at
`;
}

const MESSAGE_COLUMNS = messageColumns();

export function mapMessageRow(r: SmsMessageRowRaw): SmsMessage {
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    leadId: r.lead_id ? String(r.lead_id) : null,
    direction: (r.direction === "in" ? "in" : "out") as Direction,
    kind: (r.kind === "system" ? "system" : "sms") as SmsMessageKind,
    body: r.body,
    sentFrom: r.sent_from ?? null,
    provider: r.provider ?? null,
    providerMessageId: r.provider_message_id ?? null,
    deliveryStatus: r.delivery_status ?? null,
    deliveryError: r.delivery_error ?? null,
    sendStatus: SEND_STATUSES.has(r.send_status as SmsSendStatus)
      ? (r.send_status as SmsSendStatus)
      : "pending",
    fallbackDid: r.fallback_did === true,
    templateId: r.template_id ? String(r.template_id) : null,
    actorEmail: r.actor_email ?? null,
    occurredAt: r.occurred_at,
  };
}

export interface NewMessage {
  threadId: string;
  leadId?: string | null;
  direction: Direction;
  kind?: SmsMessageKind;
  body: string;
  sentFrom?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  sendStatus?: SmsSendStatus;
  fallbackDid?: boolean;
  templateId?: string | null;
  actorEmail?: string | null;
  occurredAt?: string | null;
}

/**
 * Insert a row. Returns null ONLY when `provider_message_id` was already
 * stored — a duplicate MO or a replayed callback — which the caller reads as
 * "already recorded", never as a failure.
 */
export async function insertMessage(m: NewMessage): Promise<SmsMessage | null> {
  if (!isDbConfigured()) return null;
  await ensureSmsMessagesSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_sms_messages
       (thread_id, lead_id, direction, kind, body, sent_from, provider, provider_message_id,
        send_status, fallback_did, template_id, actor_email, occurred_at)
     VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint, $12,
             COALESCE($13::timestamptz, NOW()))
     ON CONFLICT (provider, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      m.threadId,
      m.leadId ?? null,
      m.direction,
      m.kind ?? "sms",
      m.body,
      m.sentFrom ?? null,
      m.provider ?? null,
      m.providerMessageId ?? null,
      m.sendStatus ?? "pending",
      m.fallbackDid === true,
      m.templateId ?? null,
      m.actorEmail ?? null,
      m.occurredAt ?? null,
    ],
  )) as SmsMessageRowRaw[];
  return rows[0] ? mapMessageRow(rows[0]) : null;
}

export interface SendOutcomePatch {
  sendStatus: SmsSendStatus;
  provider?: string | null;
  providerMessageId?: string | null;
  /**
   * AUTHORITATIVE, including `null`. The caller has just heard from the
   * provider, so this is the last word on which number the message left from —
   * and `null` ("the backup carrier sent it and never said which number") must
   * overwrite the row, not be coalesced away into a comfortable lie.
   */
  sentFrom?: string | null;
  fallbackDid?: boolean;
  deliveryError?: string | null;
}

/** Write what the provider said onto the row we inserted before calling it. */
export async function patchSendOutcome(
  id: string,
  patch: SendOutcomePatch,
): Promise<SmsMessage | null> {
  if (!isDbConfigured()) return null;
  await ensureSmsMessagesSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_sms_messages
        SET send_status = $2,
            provider = COALESCE($3, provider),
            provider_message_id = COALESCE($4, provider_message_id),
            sent_from = $5,
            fallback_did = COALESCE($6::boolean, fallback_did),
            delivery_error = $7
      WHERE id = $1::bigint
      RETURNING ${MESSAGE_COLUMNS}`,
    [
      id,
      patch.sendStatus,
      patch.provider ?? null,
      patch.providerMessageId ?? null,
      patch.sentFrom ?? null,
      patch.fallbackDid ?? null,
      patch.deliveryError ?? null,
    ],
  )) as SmsMessageRowRaw[];
  return rows[0] ? mapMessageRow(rows[0]) : null;
}

/**
 * The delivery-receipt webhook's hook: patch the carrier's verdict onto the
 * matching row. Returns the row id when one matched, else null — the DR route
 * uses that to decide whether to say anything.
 */
export async function patchDeliveryStatus(input: {
  providerMessageId: string;
  status: string;
  error?: string | null;
  provider?: string | null;
}): Promise<string | null> {
  if (!isDbConfigured()) return null;
  await ensureSmsMessagesSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_sms_messages
        SET delivery_status = $2,
            delivery_error = COALESCE($3, delivery_error),
            send_status = CASE
              WHEN $2 IN ('undelivered','failed') THEN 'failed'
              WHEN send_status = 'pending' THEN 'sent'
              ELSE send_status END
      WHERE provider_message_id = $1
        AND ($4::text IS NULL OR provider = $4)
      RETURNING id::text AS id`,
    [input.providerMessageId, input.status, input.error ?? null, input.provider ?? null],
  )) as { id: string }[];
  return rows[0] ? String(rows[0].id) : null;
}

export const MESSAGE_PAGE_MAX = 200;

/**
 * A page boundary in a thread: the WHOLE sort key, `(occurred_at, id)`.
 *
 * A template send and the system line that follows it land in the same
 * millisecond, as does a burst of MO callbacks. Cursoring on the timestamp
 * alone with a strict `<` ends a page mid-tie and then excludes the entire tie
 * from the next query — "load earlier" silently loses those messages. The
 * row-value comparison below matches the ORDER BY exactly, so a tie is walked
 * through rather than jumped over.
 */
export interface MessageCursor {
  occurredAt: string;
  id: string;
}

export function encodeMessageCursor(c: MessageCursor): string {
  return `${c.occurredAt}|${c.id}`;
}

export function decodeMessageCursor(raw: string | null | undefined): MessageCursor | null {
  if (!raw) return null;
  const at = raw.lastIndexOf("|");
  if (at <= 0) return null;
  const occurredAt = raw.slice(0, at);
  const id = raw.slice(at + 1);
  return /^\d{1,19}$/.test(id) && occurredAt ? { occurredAt, id } : null;
}

/**
 * A person's messages across every rep thread they have, NEWEST FIRST, keyset
 * on `(occurred_at, id)` (R10). The view reverses them for display; paging
 * always walks backwards in time, which is what "load earlier" means.
 */
export async function listMessagesForThreads(
  threadIds: readonly string[],
  opts: { limit?: number; before?: MessageCursor | null } = {},
): Promise<SmsMessage[]> {
  if (!isDbConfigured() || threadIds.length === 0) return [];
  await ensureSmsMessagesSchema();
  const q = sql();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, MESSAGE_PAGE_MAX));
  const rows = (await q.query(
    `SELECT ${MESSAGE_COLUMNS} FROM crm_sms_messages
      WHERE thread_id = ANY($1::bigint[])
        AND ($2::timestamptz IS NULL
             OR (occurred_at, id) < ($2::timestamptz, $3::bigint))
      ORDER BY occurred_at DESC, id DESC
      LIMIT $4`,
    [threadIds, opts.before?.occurredAt ?? null, opts.before?.id ?? null, limit],
  )) as SmsMessageRowRaw[];
  return rows.map(mapMessageRow);
}

export async function getMessage(id: string): Promise<SmsMessage | null> {
  if (!isDbConfigured()) return null;
  await ensureSmsMessagesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${MESSAGE_COLUMNS} FROM crm_sms_messages WHERE id = $1::bigint`,
    [id],
  )) as SmsMessageRowRaw[];
  return rows[0] ? mapMessageRow(rows[0]) : null;
}

/** Has this guest ever texted US? The inbound half of the consent basis (R8). */
export async function hasInboundFrom(threadIds: readonly string[]): Promise<boolean> {
  if (!isDbConfigured() || threadIds.length === 0) return false;
  await ensureSmsMessagesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT 1 AS hit FROM crm_sms_messages
      WHERE thread_id = ANY($1::bigint[]) AND direction = 'in' AND kind = 'sms'
      LIMIT 1`,
    [threadIds],
  )) as { hit: number }[];
  return rows.length > 0;
}

/**
 * The last real message per thread — what the Conversations list previews.
 * System lines are excluded: "Guest texted STOP" is thread state, not the last
 * thing anyone said.
 */
export async function lastMessagePerThread(
  threadIds: readonly string[],
): Promise<Map<string, SmsMessage>> {
  const out = new Map<string, SmsMessage>();
  if (!isDbConfigured() || threadIds.length === 0) return out;
  await ensureSmsMessagesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${messageColumns("m.")} FROM (
        SELECT DISTINCT ON (thread_id) *
          FROM crm_sms_messages
         WHERE thread_id = ANY($1::bigint[]) AND kind = 'sms'
         ORDER BY thread_id, occurred_at DESC, id DESC
      ) m`,
    [threadIds],
  )) as SmsMessageRowRaw[];
  for (const r of rows) {
    const m = mapMessageRow(r);
    out.set(m.threadId, m);
  }
  return out;
}

/** Rows a retry job may pick up: an outbound text the provider never accepted. */
export async function listFailedOutbound(limit = 50): Promise<SmsMessage[]> {
  if (!isDbConfigured()) return [];
  await ensureSmsMessagesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${MESSAGE_COLUMNS} FROM crm_sms_messages
      WHERE direction = 'out' AND send_status = 'failed' AND kind = 'sms'
      ORDER BY occurred_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, MESSAGE_PAGE_MAX))],
  )) as SmsMessageRowRaw[];
  return rows.map(mapMessageRow);
}
