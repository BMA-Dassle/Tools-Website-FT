/**
 * `crm_email_links` — a Graph (or SendGrid-fallback) message tied to a lead
 * (brief §3.8), keyed `(mailbox, graph_message_id)`. Store the IMMUTABLE id
 * (`Prefer: IdType="ImmutableId"` on the draft) or the sent copy will not match.
 * `crm_graph_subscriptions` — one row per (mailbox, folder).
 *
 * PR1 shipped the two CREATE TABLEs. C2 (this sub) adds, idempotently:
 *   - the send-side columns an OUTBOUND row needs BEFORE any transport call
 *     (R2: Neon first): `send_status`, `provider`, `send_error`, `graph_error`,
 *     `body`, `cc_emails`, `actor_email`, `template_id`, `updated_at`;
 *   - `graph_message_id` becomes NULLABLE. The brief's C2 block is explicit:
 *     the outbound row is saved FIRST with `graph_message_id = NULL` and a
 *     SendGrid-fallback row keeps it NULL for good — both impossible under
 *     PR1's NOT NULL. `ALTER COLUMN … DROP NOT NULL` is idempotent and touches
 *     only this sub's own table; the `UNIQUE (mailbox, graph_message_id)`
 *     still de-duplicates Graph rows (NULLs are distinct in Postgres).
 *
 * Retention (D6, brief default): inbound rows keep `preview` + `web_link`
 * only, never the body; outbound rows keep the `body` WE composed (our own
 * data, not the guest's mailbox).
 */

import { isDbConfigured, sql } from "@ft/db";
import type { Direction } from "../../core/types";
import type { EmailProvider, EmailSendStatus } from "../contracts";

let schemaReady: Promise<void> | null = null;

export function ensureEmailSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_email_links (
        id BIGSERIAL PRIMARY KEY,
        mailbox TEXT NOT NULL,
        graph_message_id TEXT,
        conversation_id TEXT,
        internet_message_id TEXT,
        in_reply_to TEXT,
        lead_id BIGINT,
        contact_id BIGINT,
        rep_id BIGINT,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        subject TEXT,
        preview TEXT,
        from_email TEXT,
        to_emails TEXT[],
        sent_at TIMESTAMPTZ,
        matched_by TEXT,
        web_link TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (mailbox, graph_message_id)
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_email_links_lead ON crm_email_links (lead_id, sent_at DESC)`;
    // C2's columns, as ONE statement: `ALTER TABLE` takes a comma-separated
    // action list, so this is a single round trip on every cold start rather
    // than ten — `ensureCrmSchema` already issues sixty-odd statements before
    // it gets here. Every action is idempotent, which is what lets the ensure
    // run unconditionally. See the header for why graph_message_id goes
    // nullable.
    await q`
      ALTER TABLE crm_email_links
        ALTER COLUMN graph_message_id DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS send_status TEXT NOT NULL DEFAULT 'received',
        ADD COLUMN IF NOT EXISTS provider TEXT,
        ADD COLUMN IF NOT EXISTS send_error TEXT,
        ADD COLUMN IF NOT EXISTS graph_error TEXT,
        ADD COLUMN IF NOT EXISTS body TEXT,
        ADD COLUMN IF NOT EXISTS cc_emails TEXT[],
        ADD COLUMN IF NOT EXISTS actor_email TEXT,
        ADD COLUMN IF NOT EXISTS template_id BIGINT,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_email_links_imid ON crm_email_links (internet_message_id)`;
    await q`CREATE INDEX IF NOT EXISTS crm_email_links_rep ON crm_email_links (rep_id, sent_at DESC)`;
    await q`
      CREATE TABLE IF NOT EXISTS crm_graph_subscriptions (
        id BIGSERIAL PRIMARY KEY,
        mailbox TEXT NOT NULL,
        folder TEXT NOT NULL CHECK (folder IN ('inbox','sentitems')),
        subscription_id TEXT,
        client_state TEXT NOT NULL,
        expires_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'active',
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (mailbox, folder)
      )
    `;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type { EmailProvider, EmailSendStatus };

export interface EmailLinkRowRaw {
  id: string;
  mailbox: string;
  graph_message_id: string | null;
  conversation_id: string | null;
  internet_message_id: string | null;
  in_reply_to: string | null;
  lead_id: string | null;
  contact_id: string | null;
  rep_id: string | null;
  direction: string;
  subject: string | null;
  preview: string | null;
  from_email: string | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  sent_at: string | null;
  matched_by: string | null;
  web_link: string | null;
  send_status: string | null;
  provider: string | null;
  send_error: string | null;
  graph_error: string | null;
  body: string | null;
  actor_email: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface EmailLink {
  id: string;
  mailbox: string;
  graphMessageId: string | null;
  conversationId: string | null;
  internetMessageId: string | null;
  inReplyTo: string | null;
  leadId: string | null;
  contactId: string | null;
  repId: string | null;
  direction: Direction;
  subject: string | null;
  preview: string | null;
  fromEmail: string | null;
  toEmails: string[];
  ccEmails: string[];
  sentAt: string | null;
  matchedBy: string | null;
  webLink: string | null;
  sendStatus: EmailSendStatus;
  provider: EmailProvider | null;
  sendError: string | null;
  graphError: string | null;
  /** Outbound rows only — the text the rep composed. Inbound rows carry `preview` + `webLink` (D6). */
  body: string | null;
  actorEmail: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

const SEND_STATUSES = new Set<EmailSendStatus>(["pending", "sent", "failed", "received"]);

export function mapEmailLinkRow(r: EmailLinkRowRaw): EmailLink {
  return {
    id: String(r.id),
    mailbox: r.mailbox,
    graphMessageId: r.graph_message_id ?? null,
    conversationId: r.conversation_id ?? null,
    internetMessageId: r.internet_message_id ?? null,
    inReplyTo: r.in_reply_to ?? null,
    leadId: r.lead_id == null ? null : String(r.lead_id),
    contactId: r.contact_id == null ? null : String(r.contact_id),
    repId: r.rep_id == null ? null : String(r.rep_id),
    direction: r.direction === "in" ? "in" : "out",
    subject: r.subject ?? null,
    preview: r.preview ?? null,
    fromEmail: r.from_email ?? null,
    toEmails: r.to_emails ?? [],
    ccEmails: r.cc_emails ?? [],
    sentAt: r.sent_at ?? null,
    matchedBy: r.matched_by ?? null,
    webLink: r.web_link ?? null,
    sendStatus: SEND_STATUSES.has(r.send_status as EmailSendStatus)
      ? (r.send_status as EmailSendStatus)
      : "received",
    provider: r.provider === "graph" || r.provider === "sendgrid" ? r.provider : null,
    sendError: r.send_error ?? null,
    graphError: r.graph_error ?? null,
    body: r.body ?? null,
    actorEmail: r.actor_email ?? null,
    templateId: r.template_id == null ? null : String(r.template_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
  };
}

const COLUMNS = `
  id::text AS id, mailbox, graph_message_id, conversation_id, internet_message_id, in_reply_to,
  lead_id::text AS lead_id, contact_id::text AS contact_id, rep_id::text AS rep_id, direction,
  subject, preview, from_email, to_emails, cc_emails, sent_at::text AS sent_at, matched_by, web_link,
  send_status, provider, send_error, graph_error, body, actor_email, template_id::text AS template_id,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

// ---------------------------------------------------------------------------
// Outbound (R2: this INSERT happens before any Graph / SendGrid call)
// ---------------------------------------------------------------------------

export interface OutboundLinkInput {
  mailbox: string;
  leadId: string | null;
  contactId: string | null;
  repId: string | null;
  /** The lead's public id, also sent as the X-HP-Lead header. */
  subject: string;
  body: string;
  toEmails: string[];
  ccEmails: string[];
  actorEmail: string;
  templateId: string | null;
  internetMessageId: string;
  inReplyTo: string | null;
}

export async function insertOutboundLink(input: OutboundLinkInput): Promise<EmailLink> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_email_links
       (mailbox, graph_message_id, internet_message_id, in_reply_to, lead_id, contact_id, rep_id, direction,
        subject, preview, body, from_email, to_emails, cc_emails, actor_email, template_id, send_status, matched_by)
     VALUES ($1, NULL, $2, $3, $4::bigint, $5::bigint, $6::bigint, 'out',
             $7, $8, $9, $1, $10::text[], $11::text[], $12, $13::bigint, 'pending', 'composer')
     RETURNING ${COLUMNS}`,
    [
      input.mailbox,
      input.internetMessageId,
      input.inReplyTo,
      input.leadId,
      input.contactId,
      input.repId,
      input.subject,
      input.body.slice(0, 200),
      input.body,
      input.toEmails,
      input.ccEmails,
      input.actorEmail,
      input.templateId,
    ],
  )) as EmailLinkRowRaw[];
  if (!rows[0]) throw new Error("crm_email_links: insert returned nothing");
  return mapEmailLinkRow(rows[0]);
}

/** After the Graph draft: store the IMMUTABLE id before the /send call. */
export async function setLinkGraphMessageId(
  id: string,
  graphMessageId: string,
  conversationId: string | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureEmailSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_email_links
        SET graph_message_id = $2, conversation_id = COALESCE($3, conversation_id), updated_at = NOW()
      WHERE id = $1::bigint`,
    [id, graphMessageId, conversationId],
  );
}

export async function markLinkSent(
  id: string,
  provider: EmailProvider,
  opts: { graphError?: string | null; sentAt?: Date } = {},
): Promise<EmailLink | null> {
  if (!isDbConfigured()) return null;
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_email_links
        SET send_status = 'sent', provider = $2, send_error = NULL,
            graph_error = COALESCE($3, graph_error),
            sent_at = COALESCE($4::timestamptz, NOW()), updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING ${COLUMNS}`,
    [id, provider, opts.graphError ?? null, opts.sentAt ? opts.sentAt.toISOString() : null],
  )) as EmailLinkRowRaw[];
  return rows[0] ? mapEmailLinkRow(rows[0]) : null;
}

/**
 * Graph took the draft but `/send` did not answer — the message may or may not
 * have gone. The row stays `pending` (never `failed`, which the UI reads as
 * "nothing left", and never `sent`, which would be a lie) with the Graph
 * complaint recorded, and `email-send-retry` re-reads before it retries.
 */
export async function markLinkPending(id: string, graphError: string): Promise<EmailLink | null> {
  if (!isDbConfigured()) return null;
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_email_links
        SET send_status = 'pending', send_error = $2, graph_error = $2, updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING ${COLUMNS}`,
    [id, graphError.slice(0, 2000)],
  )) as EmailLinkRowRaw[];
  return rows[0] ? mapEmailLinkRow(rows[0]) : null;
}

export async function markLinkFailed(
  id: string,
  error: string,
  opts: { graphError?: string | null } = {},
): Promise<EmailLink | null> {
  if (!isDbConfigured()) return null;
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_email_links
        SET send_status = 'failed', send_error = $2,
            graph_error = COALESCE($3, graph_error), updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING ${COLUMNS}`,
    [id, error.slice(0, 2000), opts.graphError ?? null],
  )) as EmailLinkRowRaw[];
  return rows[0] ? mapEmailLinkRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Inbound / Outlook-originated (from the webhook or the fetch job)
// ---------------------------------------------------------------------------

export interface GraphLinkInput {
  mailbox: string;
  graphMessageId: string;
  conversationId: string | null;
  internetMessageId: string | null;
  inReplyTo: string | null;
  leadId: string | null;
  contactId: string | null;
  repId: string | null;
  direction: Direction;
  subject: string | null;
  preview: string | null;
  fromEmail: string | null;
  toEmails: string[];
  ccEmails: string[];
  sentAt: string | null;
  matchedBy: string | null;
  webLink: string | null;
}

/**
 * Insert a Graph message once. A duplicate notification (or the Sent Items
 * copy of a message the CRM itself sent under the same immutable id) hits
 * `UNIQUE (mailbox, graph_message_id)` and returns `null` — nothing else runs.
 */
export async function insertGraphLinkOnce(input: GraphLinkInput): Promise<EmailLink | null> {
  if (!isDbConfigured()) return null;
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_email_links
       (mailbox, graph_message_id, conversation_id, internet_message_id, in_reply_to, lead_id, contact_id, rep_id,
        direction, subject, preview, from_email, to_emails, cc_emails, sent_at, matched_by, web_link,
        send_status, provider)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8::bigint,
             $9, $10, $11, $12, $13::text[], $14::text[], $15::timestamptz, $16, $17,
             'received', 'graph')
     ON CONFLICT (mailbox, graph_message_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.mailbox,
      input.graphMessageId,
      input.conversationId,
      input.internetMessageId,
      input.inReplyTo,
      input.leadId,
      input.contactId,
      input.repId,
      input.direction,
      input.subject,
      input.preview,
      input.fromEmail,
      input.toEmails,
      input.ccEmails,
      input.sentAt,
      input.matchedBy,
      input.webLink,
    ],
  )) as EmailLinkRowRaw[];
  return rows[0] ? mapEmailLinkRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Reads (keyset pagination, limit ≤ 200 — R10)
// ---------------------------------------------------------------------------

export const MAX_PAGE = 200;

export function clampLimit(limit: number | undefined, fallback = 50): number {
  const n = Number.isFinite(limit) ? Math.floor(limit as number) : fallback;
  return Math.min(MAX_PAGE, Math.max(1, n));
}

export async function getLink(id: string): Promise<EmailLink | null> {
  if (!isDbConfigured()) return null;
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_email_links WHERE id = $1::bigint`, [
    id,
  ])) as EmailLinkRowRaw[];
  return rows[0] ? mapEmailLinkRow(rows[0]) : null;
}

/** The link row whose Message-ID a reply's In-Reply-To names. */
export async function findLinkByInternetMessageId(imid: string): Promise<EmailLink | null> {
  if (!isDbConfigured()) return null;
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_email_links WHERE internet_message_id = $1 ORDER BY id ASC LIMIT 1`,
    [imid],
  )) as EmailLinkRowRaw[];
  return rows[0] ? mapEmailLinkRow(rows[0]) : null;
}

/** Cursor = the previous page's last `(sentAt, id)`, encoded by the service. */
export interface LeadEmailsPage {
  items: EmailLink[];
  nextCursor: { sentAt: string; id: string } | null;
}

/** One lead's messages, newest first (the Email tab's order, crm-shared.js:325). */
export async function listLeadEmails(
  leadId: string,
  opts: { limit?: number; before?: { sentAt: string; id: string } | null } = {},
): Promise<LeadEmailsPage> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureEmailSchema();
  const q = sql();
  const limit = clampLimit(opts.limit);
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_email_links
      WHERE lead_id = $1::bigint
        AND ($2::timestamptz IS NULL
             OR (COALESCE(sent_at, created_at), id) < ($2::timestamptz, $3::bigint))
      ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
      LIMIT $4`,
    [leadId, opts.before?.sentAt ?? null, opts.before?.id ?? null, limit + 1],
  )) as EmailLinkRowRaw[];
  const items = rows.slice(0, limit).map(mapEmailLinkRow);
  const more = rows.length > limit;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: more && last ? { sentAt: last.sentAt ?? last.createdAt, id: last.id } : null,
  };
}

export interface EmailThreadRow {
  leadId: string;
  lastAt: string;
  count: number;
  last: EmailLink;
}

/**
 * One row per lead: its latest message. Scoped to a rep's mailbox rows when
 * `repId` is given (a rep sees their own threads; a director sees all).
 */
export async function listEmailThreads(
  opts: {
    repId?: string | null;
    limit?: number;
    before?: { lastAt: string; leadId: string } | null;
  } = {},
): Promise<{ items: EmailThreadRow[]; nextCursor: { lastAt: string; leadId: string } | null }> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureEmailSchema();
  const q = sql();
  const limit = clampLimit(opts.limit);
  const rows = (await q.query(
    `WITH ranked AS (
       SELECT l.*, COALESCE(l.sent_at, l.created_at) AS at,
              ROW_NUMBER() OVER (PARTITION BY l.lead_id ORDER BY COALESCE(l.sent_at, l.created_at) DESC, l.id DESC) AS rn,
              COUNT(*) OVER (PARTITION BY l.lead_id) AS n
         FROM crm_email_links l
        WHERE l.lead_id IS NOT NULL
          AND ($1::bigint IS NULL OR l.rep_id = $1::bigint)
     )
     SELECT ${COLUMNS}, at::text AS last_at, n::int AS n
       FROM ranked
      WHERE rn = 1
        AND ($2::timestamptz IS NULL OR (at, lead_id) < ($2::timestamptz, $3::bigint))
      ORDER BY at DESC, lead_id DESC
      LIMIT $4`,
    [opts.repId ?? null, opts.before?.lastAt ?? null, opts.before?.leadId ?? null, limit + 1],
  )) as (EmailLinkRowRaw & { last_at: string; n: number })[];
  const page = rows.slice(0, limit);
  const items: EmailThreadRow[] = page.map((r) => ({
    leadId: String(r.lead_id),
    lastAt: r.last_at,
    count: Number(r.n) || 1,
    last: mapEmailLinkRow(r),
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? { lastAt: last.lastAt, leadId: last.leadId } : null,
  };
}

/** One row per CONTACT: their latest email, whether or not it has a lead. */
export interface EmailContactThread {
  contactId: string;
  lastAt: string;
  count: number;
  last: EmailLink;
}

/**
 * The same fold as `listEmailThreads`, but per CONTACT rather than per lead —
 * which is what the Conversations screen is keyed on.
 *
 * That screen is "one entry per person" and its key format already allows
 * `c-<contactId>`, but `loadConversations` only ever read `crm_sms_threads`.
 * So a guest who had been emailed and never texted appeared nowhere, and the
 * Email tab filtered a list that could only contain texts — owner, 2026-09-14:
 * "why nothing showing under conversasions" over a screen with two sent
 * emails in the table and no SMS threads at all.
 *
 * `lead_id` is NOT required here, unlike the per-lead fold: an email to a
 * contact we have not yet turned into a lead is still a conversation somebody
 * is having.
 */
export async function latestEmailPerContact(
  opts: { repId?: string | null; limit?: number } = {},
): Promise<EmailContactThread[]> {
  if (!isDbConfigured()) return [];
  await ensureEmailSchema();
  const q = sql();
  const limit = clampLimit(opts.limit);
  const rows = (await q.query(
    `WITH ranked AS (
       SELECT l.*, COALESCE(l.sent_at, l.created_at) AS at,
              ROW_NUMBER() OVER (PARTITION BY l.contact_id ORDER BY COALESCE(l.sent_at, l.created_at) DESC, l.id DESC) AS rn,
              COUNT(*) OVER (PARTITION BY l.contact_id) AS n
         FROM crm_email_links l
        WHERE l.contact_id IS NOT NULL
          AND ($1::bigint IS NULL OR l.rep_id = $1::bigint)
     )
     SELECT ${COLUMNS}, at::text AS last_at, n::int AS n
       FROM ranked
      WHERE rn = 1
      ORDER BY at DESC, contact_id DESC
      LIMIT $2`,
    [opts.repId ?? null, limit],
  )) as (EmailLinkRowRaw & { last_at: string; n: number })[];
  return rows.map((r) => ({
    contactId: String(r.contact_id),
    lastAt: r.last_at,
    count: Number(r.n) || 1,
    last: mapEmailLinkRow(r),
  }));
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type GraphFolder = "inbox" | "sentitems";
export const GRAPH_FOLDERS: readonly GraphFolder[] = ["inbox", "sentitems"];

export interface GraphSubscriptionRow {
  id: string;
  mailbox: string;
  folder: GraphFolder;
  subscriptionId: string | null;
  clientState: string;
  expiresAt: string | null;
  status: string;
  lastError: string | null;
  updatedAt: string;
}

interface SubRowRaw {
  id: string;
  mailbox: string;
  folder: string;
  subscription_id: string | null;
  client_state: string;
  expires_at: string | null;
  status: string;
  last_error: string | null;
  updated_at: string;
}

function mapSub(r: SubRowRaw): GraphSubscriptionRow {
  return {
    id: String(r.id),
    mailbox: r.mailbox,
    folder: r.folder === "sentitems" ? "sentitems" : "inbox",
    subscriptionId: r.subscription_id ?? null,
    clientState: r.client_state,
    expiresAt: r.expires_at ?? null,
    status: r.status,
    lastError: r.last_error ?? null,
    updatedAt: r.updated_at,
  };
}

const SUB_COLUMNS = `id::text AS id, mailbox, folder, subscription_id, client_state,
  expires_at::text AS expires_at, status, last_error, updated_at::text AS updated_at`;

export async function listSubscriptions(): Promise<GraphSubscriptionRow[]> {
  if (!isDbConfigured()) return [];
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${SUB_COLUMNS} FROM crm_graph_subscriptions ORDER BY mailbox, folder`,
  )) as SubRowRaw[];
  return rows.map(mapSub);
}

/** The row a notification's `subscriptionId` names — the ONLY source of the expected clientState. */
export async function findSubscriptionById(
  subscriptionId: string,
): Promise<GraphSubscriptionRow | null> {
  if (!isDbConfigured()) return null;
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${SUB_COLUMNS} FROM crm_graph_subscriptions WHERE subscription_id = $1 LIMIT 1`,
    [subscriptionId],
  )) as SubRowRaw[];
  return rows[0] ? mapSub(rows[0]) : null;
}

/** Ensure a row exists for (mailbox, folder); an existing row keeps its clientState. */
export async function upsertSubscriptionRow(
  mailbox: string,
  folder: GraphFolder,
  clientState: string,
): Promise<GraphSubscriptionRow> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureEmailSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_graph_subscriptions (mailbox, folder, client_state)
     VALUES ($1, $2, $3)
     ON CONFLICT (mailbox, folder) DO UPDATE SET updated_at = NOW()
     RETURNING ${SUB_COLUMNS}`,
    [mailbox.toLowerCase(), folder, clientState],
  )) as SubRowRaw[];
  if (!rows[0]) throw new Error("crm_graph_subscriptions: upsert returned nothing");
  return mapSub(rows[0]);
}

export async function recordSubscription(
  id: string,
  patch: { subscriptionId: string; expiresAt: string; clientState?: string },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureEmailSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_graph_subscriptions
        SET subscription_id = $2, expires_at = $3::timestamptz, status = 'active', last_error = NULL,
            client_state = COALESCE($4, client_state), updated_at = NOW()
      WHERE id = $1::bigint`,
    [id, patch.subscriptionId, patch.expiresAt, patch.clientState ?? null],
  );
}

export async function recordSubscriptionError(id: string, error: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureEmailSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_graph_subscriptions
        SET status = 'error', last_error = $2, updated_at = NOW()
      WHERE id = $1::bigint`,
    [id, error.slice(0, 2000)],
  );
}
