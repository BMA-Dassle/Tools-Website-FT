import { sql, isDbConfigured } from "@/lib/db";

/**
 * Group Function Quotes — Neon data layer.
 *
 * Tracks the full lifecycle of group event quotes from Hermes queue
 * detection through PandaDoc signing, deposit collection, 72-hour
 * balance charge, and day-of revenue conversion.
 *
 * Schema is auto-bootstrapped on first write via `ensureGfSchema()`.
 *
 * ── BMI precision rule ────────────────────────────────────────────
 * bmi_reservation_id is TEXT. NEVER pass through Number() or
 * JSON.stringify() — BMI IDs exceed Number.MAX_SAFE_INTEGER.
 */

// ── Schema bootstrap ────────────────────────────────────────────────

let schemaReady = false;

export async function ensureGfSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();

  await q`
    CREATE TABLE IF NOT EXISTS group_function_quotes (
      id                        BIGSERIAL PRIMARY KEY,

      -- BMI / Hermes
      bmi_reservation_id        TEXT NOT NULL,
      hermes_queue_id           INTEGER,
      hermes_log_id             INTEGER,
      hermes_center             TEXT NOT NULL,

      -- Center + planner
      center_code               TEXT NOT NULL,
      center_name               TEXT NOT NULL,
      square_location_id        TEXT NOT NULL,
      planner_first             TEXT,
      planner_last              TEXT,
      planner_email             TEXT,
      planner_phone             TEXT,

      -- Guest contact
      guest_first_name          TEXT NOT NULL,
      guest_last_name           TEXT NOT NULL,
      guest_email               TEXT NOT NULL,
      guest_phone               TEXT,

      -- Event
      event_name                TEXT,
      event_number              TEXT,
      event_date                TIMESTAMPTZ NOT NULL,
      event_date_display        TEXT,
      guest_count               INTEGER,
      notes                     TEXT,

      -- Financials (cents)
      total_cents               INTEGER NOT NULL DEFAULT 0,
      tax_cents                 INTEGER NOT NULL DEFAULT 0,
      deposit_due_cents         INTEGER NOT NULL DEFAULT 0,
      balance_cents             INTEGER NOT NULL DEFAULT 0,

      -- Line items from Hermes (JSONB)
      line_items                JSONB NOT NULL DEFAULT '[]',
      prior_payments            JSONB NOT NULL DEFAULT '[]',

      -- Template selection
      pandadoc_template         TEXT,
      pandadoc_template_id      TEXT,

      -- PandaDoc contract
      pandadoc_document_id      TEXT,
      contract_short_id         TEXT,
      contract_status           TEXT,
      contract_sent_at          TIMESTAMPTZ,
      contract_signed_at        TIMESTAMPTZ,

      -- Deposit (at signing)
      square_deposit_order_id   TEXT,
      square_deposit_payment_id TEXT,
      square_gift_card_id       TEXT,
      square_gift_card_gan      TEXT,
      square_customer_id        TEXT,
      saved_card_id             TEXT,
      deposit_paid_at           TIMESTAMPTZ,

      -- Balance (at T-72h)
      square_balance_order_id   TEXT,
      square_balance_payment_id TEXT,
      balance_paid_at           TIMESTAMPTZ,
      balance_payment_method    TEXT,
      balance_payment_link_url  TEXT,
      balance_link_sent_at      TIMESTAMPTZ,

      -- Day-of
      square_dayof_order_id     TEXT,

      -- Status + tracking
      status                    TEXT NOT NULL DEFAULT 'pending',
      teams_card_activity_id    TEXT,
      teams_card_conversation_id TEXT,
      balance_charge_attempts   INTEGER NOT NULL DEFAULT 0,
      balance_last_error        TEXT,

      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Brand/URL columns
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS brand TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS base_url TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS gan_prefix TEXT`;

  // New columns added post-initial schema (idempotent)
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS deposit_attempts INTEGER NOT NULL DEFAULT 0`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS deposit_last_error TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS hermes_last_processed_at TIMESTAMPTZ`;
  // Compliance columns
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS document_seal TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS signed_pdf_url TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS otp_verified_at TIMESTAMPTZ`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS otp_method TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS signer_ip TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS signer_ua TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS signature_type TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS signature_data TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS signed_pdf_history JSONB DEFAULT '[]'`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS dayof_paid_at TIMESTAMPTZ`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS dayof_payment_ids JSONB`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS dayof_payment_error TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT FALSE`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS approved_by TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS denied_at TIMESTAMPTZ`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS denied_by TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS denial_reason TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS approval_memo TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS is_tax_exempt BOOLEAN NOT NULL DEFAULT FALSE`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS tax_file_url TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS waiver_reminder_sent_at TIMESTAMPTZ`;

  // Immutable audit trail
  await q`
    CREATE TABLE IF NOT EXISTS contract_audit_log (
      id            BIGSERIAL PRIMARY KEY,
      quote_id      INTEGER NOT NULL,
      event         TEXT NOT NULL,
      actor_email   TEXT,
      actor_ip      TEXT,
      actor_ua      TEXT,
      metadata      JSONB DEFAULT '{}',
      document_hash TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS cal_quote ON contract_audit_log(quote_id)`;
  await q`CREATE INDEX IF NOT EXISTS cal_event ON contract_audit_log(event)`;

  await q`CREATE UNIQUE INDEX IF NOT EXISTS gfq_bmi_reservation
    ON group_function_quotes(bmi_reservation_id)`;
  await q`CREATE INDEX IF NOT EXISTS gfq_status
    ON group_function_quotes(status)`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS gfq_contract_short
    ON group_function_quotes(contract_short_id)
    WHERE contract_short_id IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS gfq_balance_due
    ON group_function_quotes(event_date)
    WHERE status IN ('deposit_paid','balance_link_sent')`;
  await q`CREATE INDEX IF NOT EXISTS gfq_pandadoc_doc
    ON group_function_quotes(pandadoc_document_id)
    WHERE pandadoc_document_id IS NOT NULL`;

  schemaReady = true;
}

// ── Types ───────────────────────────────────────────────────────────

export type GfQuoteStatus =
  | "pending"
  | "pending_approval"
  | "contract_sent"
  | "deposit_paid"
  | "resign_required"
  | "balance_charged"
  | "balance_link_sent"
  | "completed"
  | "cancelled"
  | "denied"
  | "expired";

export interface GroupFunctionQuote {
  id: number;
  bmi_reservation_id: string;
  hermes_queue_id: number | null;
  hermes_log_id: number | null;
  hermes_center: string;
  center_code: string;
  center_name: string;
  square_location_id: string;
  brand: string | null;
  base_url: string | null;
  gan_prefix: string | null;
  planner_first: string | null;
  planner_last: string | null;
  planner_email: string | null;
  planner_phone: string | null;
  guest_first_name: string;
  guest_last_name: string;
  guest_email: string;
  guest_phone: string | null;
  event_name: string | null;
  event_number: string | null;
  event_date: string;
  event_date_display: string | null;
  guest_count: number | null;
  notes: string | null;
  total_cents: number;
  tax_cents: number;
  deposit_due_cents: number;
  balance_cents: number;
  line_items: unknown[];
  prior_payments: unknown[];
  pandadoc_template: string | null;
  pandadoc_template_id: string | null;
  pandadoc_document_id: string | null;
  contract_short_id: string | null;
  contract_status: string | null;
  contract_sent_at: string | null;
  contract_signed_at: string | null;
  square_deposit_order_id: string | null;
  square_deposit_payment_id: string | null;
  square_gift_card_id: string | null;
  square_gift_card_gan: string | null;
  square_customer_id: string | null;
  saved_card_id: string | null;
  deposit_paid_at: string | null;
  square_balance_order_id: string | null;
  square_balance_payment_id: string | null;
  balance_paid_at: string | null;
  balance_payment_method: string | null;
  balance_payment_link_url: string | null;
  balance_link_sent_at: string | null;
  square_dayof_order_id: string | null;
  status: GfQuoteStatus;
  teams_card_activity_id: string | null;
  teams_card_conversation_id: string | null;
  balance_charge_attempts: number;
  balance_last_error: string | null;
  deposit_attempts: number;
  deposit_last_error: string | null;
  hermes_last_processed_at: string | null;
  document_seal: string | null;
  signed_pdf_url: string | null;
  signed_pdf_history: unknown[];
  dayof_paid_at: string | null;
  dayof_payment_ids: unknown[] | null;
  dayof_payment_error: string | null;
  approval_required: boolean;
  approved_at: string | null;
  approved_by: string | null;
  denied_at: string | null;
  denied_by: string | null;
  denial_reason: string | null;
  approval_memo: string | null;
  is_tax_exempt: boolean;
  tax_file_url: string | null;
  waiver_reminder_sent_at: string | null;
  otp_verified_at: string | null;
  otp_method: string | null;
  signer_ip: string | null;
  signer_ua: string | null;
  signature_type: string | null;
  signature_data: string | null;
  created_at: string;
  updated_at: string;
}

// ── Insert ──────────────────────────────────────────────────────────

export interface InsertGfQuoteParams {
  bmi_reservation_id: string;
  hermes_queue_id?: number;
  hermes_log_id?: number;
  hermes_center: string;
  center_code: string;
  center_name: string;
  square_location_id: string;
  brand?: string;
  base_url?: string;
  gan_prefix?: string;
  planner_first?: string;
  planner_last?: string;
  planner_email?: string;
  planner_phone?: string;
  guest_first_name: string;
  guest_last_name: string;
  guest_email: string;
  guest_phone?: string;
  event_name?: string;
  event_number?: string;
  event_date: string;
  event_date_display?: string;
  guest_count?: number;
  notes?: string;
  total_cents: number;
  tax_cents: number;
  deposit_due_cents: number;
  balance_cents: number;
  line_items: unknown[];
  prior_payments: unknown[];
  pandadoc_template?: string;
  pandadoc_template_id?: string;
  is_tax_exempt?: boolean;
}

export async function insertGfQuote(params: InsertGfQuoteParams): Promise<GroupFunctionQuote> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    INSERT INTO group_function_quotes (
      bmi_reservation_id, hermes_queue_id, hermes_log_id, hermes_center,
      center_code, center_name, square_location_id, brand, base_url, gan_prefix,
      planner_first, planner_last, planner_email, planner_phone,
      guest_first_name, guest_last_name, guest_email, guest_phone,
      event_name, event_number, event_date, event_date_display,
      guest_count, notes,
      total_cents, tax_cents, deposit_due_cents, balance_cents,
      line_items, prior_payments,
      pandadoc_template, pandadoc_template_id,
      is_tax_exempt, status
    ) VALUES (
      ${params.bmi_reservation_id},
      ${params.hermes_queue_id ?? null},
      ${params.hermes_log_id ?? null},
      ${params.hermes_center},
      ${params.center_code},
      ${params.center_name},
      ${params.square_location_id},
      ${params.brand ?? null},
      ${params.base_url ?? null},
      ${params.gan_prefix ?? null},
      ${params.planner_first ?? null},
      ${params.planner_last ?? null},
      ${params.planner_email ?? null},
      ${params.planner_phone ?? null},
      ${params.guest_first_name},
      ${params.guest_last_name},
      ${params.guest_email},
      ${params.guest_phone ?? null},
      ${params.event_name ?? null},
      ${params.event_number ?? null},
      ${params.event_date},
      ${params.event_date_display ?? null},
      ${params.guest_count ?? null},
      ${params.notes ?? null},
      ${params.total_cents},
      ${params.tax_cents},
      ${params.deposit_due_cents},
      ${params.balance_cents},
      ${JSON.stringify(params.line_items)},
      ${JSON.stringify(params.prior_payments)},
      ${params.pandadoc_template ?? null},
      ${params.pandadoc_template_id ?? null},
      ${params.is_tax_exempt ?? false},
      'pending'
    )
    RETURNING *
  `;
  return rows[0] as GroupFunctionQuote;
}

// ── Lookups ─────────────────────────────────────────────────────────

export async function getGfQuoteByReservationId(
  reservationId: string,
): Promise<GroupFunctionQuote | null> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE bmi_reservation_id = ${reservationId}
    LIMIT 1
  `;
  return (rows[0] as GroupFunctionQuote) ?? null;
}

export async function getGfQuoteByShortId(shortId: string): Promise<GroupFunctionQuote | null> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE contract_short_id = ${shortId}
    LIMIT 1
  `;
  return (rows[0] as GroupFunctionQuote) ?? null;
}

export async function getGfQuoteByPandaDocId(
  documentId: string,
): Promise<GroupFunctionQuote | null> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE pandadoc_document_id = ${documentId}
    LIMIT 1
  `;
  return (rows[0] as GroupFunctionQuote) ?? null;
}

// ── Balance-due queries ─────────────────────────────────────────────

export async function getQuotesNeedingBalanceCharge(): Promise<GroupFunctionQuote[]> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE status = 'deposit_paid'
      AND event_date - INTERVAL '72 hours' <= NOW()
      AND event_date > NOW()
    ORDER BY event_date ASC
  `;
  return rows as GroupFunctionQuote[];
}

export async function getQuotesWithPendingBalanceLinks(): Promise<GroupFunctionQuote[]> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE status = 'balance_link_sent'
      AND event_date > NOW()
    ORDER BY event_date ASC
  `;
  return rows as GroupFunctionQuote[];
}

// ── Updates ─────────────────────────────────────────────────────────

// ── Targeted update helpers ──────────────────────────────────────────
// Each lifecycle transition gets its own function (matches bowling-db pattern).

export async function updateGfContractSent(
  id: number,
  fields: {
    pandadoc_document_id?: string;
    pandadoc_template?: string;
    pandadoc_template_id?: string;
    contract_short_id: string;
    contract_status: string;
    contract_sent_at: string;
  },
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      pandadoc_document_id = ${fields.pandadoc_document_id ?? null},
      pandadoc_template = ${fields.pandadoc_template ?? null},
      pandadoc_template_id = ${fields.pandadoc_template_id ?? null},
      contract_short_id = ${fields.contract_short_id},
      contract_status = ${fields.contract_status},
      contract_sent_at = ${fields.contract_sent_at},
      status = 'contract_sent',
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function updateGfContractStatus(
  id: number,
  contractStatus: string,
  signedAt?: string,
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  if (signedAt) {
    await q`
      UPDATE group_function_quotes SET
        contract_status = ${contractStatus},
        contract_signed_at = ${signedAt},
        updated_at = NOW()
      WHERE id = ${id}
    `;
  } else {
    await q`
      UPDATE group_function_quotes SET
        contract_status = ${contractStatus},
        updated_at = NOW()
      WHERE id = ${id}
    `;
  }
}

export async function updateGfDepositPaid(
  id: number,
  fields: {
    square_deposit_order_id: string;
    square_deposit_payment_id: string;
    square_gift_card_id: string;
    square_gift_card_gan: string;
    square_customer_id?: string;
    saved_card_id?: string;
    square_dayof_order_id?: string;
    deposit_paid_at: string;
    balance_cents: number;
  },
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      square_deposit_order_id = ${fields.square_deposit_order_id},
      square_deposit_payment_id = ${fields.square_deposit_payment_id},
      square_gift_card_id = ${fields.square_gift_card_id},
      square_gift_card_gan = ${fields.square_gift_card_gan},
      square_customer_id = ${fields.square_customer_id ?? null},
      saved_card_id = ${fields.saved_card_id ?? null},
      square_dayof_order_id = ${fields.square_dayof_order_id ?? null},
      deposit_paid_at = ${fields.deposit_paid_at},
      balance_cents = ${fields.balance_cents},
      status = 'deposit_paid',
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function updateGfBalanceCharged(
  id: number,
  fields: {
    square_balance_order_id: string;
    square_balance_payment_id: string;
    balance_paid_at: string;
    balance_payment_method: string;
  },
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      square_balance_order_id = ${fields.square_balance_order_id},
      square_balance_payment_id = ${fields.square_balance_payment_id},
      balance_paid_at = ${fields.balance_paid_at},
      balance_payment_method = ${fields.balance_payment_method},
      balance_cents = 0,
      status = 'balance_charged',
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function updateGfBalanceLinkSent(
  id: number,
  fields: {
    balance_payment_link_url: string;
    balance_link_sent_at: string;
    balance_charge_attempts: number;
    balance_last_error?: string;
  },
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      balance_payment_link_url = ${fields.balance_payment_link_url},
      balance_link_sent_at = ${fields.balance_link_sent_at},
      balance_charge_attempts = ${fields.balance_charge_attempts},
      balance_last_error = ${fields.balance_last_error ?? null},
      status = 'balance_link_sent',
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function updateGfStatus(id: number, status: GfQuoteStatus): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      status = ${status},
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function updateGfTeamsCard(
  id: number,
  activityId: string,
  conversationId?: string,
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      teams_card_activity_id = ${activityId},
      teams_card_conversation_id = ${conversationId ?? null},
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

// ── Quote detail updates (for live modifications) ───────────────────

export async function updateGfQuoteDetails(
  id: number,
  fields: {
    event_name?: string;
    event_number?: string;
    event_date?: string;
    event_date_display?: string;
    guest_count?: number;
    notes?: string;
    total_cents?: number;
    tax_cents?: number;
    deposit_due_cents?: number;
    balance_cents?: number;
    line_items?: unknown[];
    prior_payments?: unknown[];
    planner_first?: string;
    planner_last?: string;
    planner_email?: string;
    planner_phone?: string;
    guest_first_name?: string;
    guest_last_name?: string;
    guest_email?: string;
    guest_phone?: string;
    hermes_last_processed_at?: string;
  },
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      event_name = COALESCE(${fields.event_name ?? null}, event_name),
      event_number = COALESCE(${fields.event_number ?? null}, event_number),
      event_date = COALESCE(${fields.event_date ?? null}::timestamptz, event_date),
      event_date_display = COALESCE(${fields.event_date_display ?? null}, event_date_display),
      guest_count = COALESCE(${fields.guest_count ?? null}, guest_count),
      notes = COALESCE(${fields.notes ?? null}, notes),
      total_cents = COALESCE(${fields.total_cents ?? null}, total_cents),
      tax_cents = COALESCE(${fields.tax_cents ?? null}, tax_cents),
      deposit_due_cents = COALESCE(${fields.deposit_due_cents ?? null}, deposit_due_cents),
      balance_cents = COALESCE(${fields.balance_cents ?? null}, balance_cents),
      line_items = COALESCE(${fields.line_items ? JSON.stringify(fields.line_items) : null}::jsonb, line_items),
      prior_payments = COALESCE(${fields.prior_payments ? JSON.stringify(fields.prior_payments) : null}::jsonb, prior_payments),
      planner_first = COALESCE(${fields.planner_first ?? null}, planner_first),
      planner_last = COALESCE(${fields.planner_last ?? null}, planner_last),
      planner_email = COALESCE(${fields.planner_email ?? null}, planner_email),
      planner_phone = COALESCE(${fields.planner_phone ?? null}, planner_phone),
      guest_first_name = COALESCE(${fields.guest_first_name ?? null}, guest_first_name),
      guest_last_name = COALESCE(${fields.guest_last_name ?? null}, guest_last_name),
      guest_email = COALESCE(${fields.guest_email ?? null}, guest_email),
      guest_phone = COALESCE(${fields.guest_phone ?? null}, guest_phone),
      hermes_last_processed_at = COALESCE(${fields.hermes_last_processed_at ?? null}::timestamptz, hermes_last_processed_at),
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function updateGfDepositAttempt(id: number, error: string): Promise<number> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    UPDATE group_function_quotes SET
      deposit_attempts = deposit_attempts + 1,
      deposit_last_error = ${error},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING deposit_attempts
  `;
  return (rows[0] as { deposit_attempts: number })?.deposit_attempts ?? 0;
}

// ── Audit trail ─────────────────────────────────────────────────────

export async function appendAuditLog(params: {
  quoteId: number;
  event: string;
  actorEmail?: string;
  actorIp?: string;
  actorUa?: string;
  metadata?: Record<string, unknown>;
  documentHash?: string;
}): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    INSERT INTO contract_audit_log (quote_id, event, actor_email, actor_ip, actor_ua, metadata, document_hash)
    VALUES (
      ${params.quoteId},
      ${params.event},
      ${params.actorEmail ?? null},
      ${params.actorIp ?? null},
      ${params.actorUa ?? null},
      ${JSON.stringify(params.metadata ?? {})},
      ${params.documentHash ?? null}
    )
  `;
}

export interface AuditLogEntry {
  id: number;
  quote_id: number;
  event: string;
  actor_email: string | null;
  actor_ip: string | null;
  actor_ua: string | null;
  metadata: Record<string, unknown>;
  document_hash: string | null;
  created_at: string;
}

export async function getAuditLog(quoteId: number): Promise<AuditLogEntry[]> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM contract_audit_log
    WHERE quote_id = ${quoteId}
    ORDER BY created_at ASC
  `;
  return rows as AuditLogEntry[];
}

// ── Gift card array helpers ─────────────────────────────────────────

export function parseGiftCardIds(raw: string | null): string[] {
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }
  return [raw];
}

export function parseGiftCardGans(raw: string | null): string[] {
  return parseGiftCardIds(raw);
}

// ── List ────────────────────────────────────────────────────────────

export async function listGfQuotes(opts?: {
  status?: GfQuoteStatus;
  limit?: number;
}): Promise<GroupFunctionQuote[]> {
  await ensureGfSchema();
  const q = sql();
  const limit = opts?.limit ?? 50;

  if (opts?.status) {
    const rows = await q`
      SELECT * FROM group_function_quotes
      WHERE status = ${opts.status}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows as GroupFunctionQuote[];
  }

  const rows = await q`
    SELECT * FROM group_function_quotes
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows as GroupFunctionQuote[];
}
