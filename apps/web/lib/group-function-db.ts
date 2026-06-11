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

  // Money actually collected to date (cents). Universal rule: amount_due = total_cents - collected_cents.
  // Set at every real collection point (deposit, balance charge, prepaid, link reconcile, reprice).
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS collected_cents INTEGER NOT NULL DEFAULT 0`;
  // Square order id behind a balance payment LINK, captured at link creation so the
  // reconcile poller can detect when the customer pays it.
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS square_balance_link_id TEXT`;

  // Square-settled-outside-our-flow: a paid-out Square order (its NAME starts with
  // "BMI…") that collected an event's money directly in Square, never through our
  // contract/deposit/balance rail. Recorded when group-square-settled-close jumps a
  // stuck-but-paid event to 'completed'. The partial unique index makes it impossible
  // to attribute one Square order to two quotes — a same-priced collision surfaces as
  // a duplicate-key error the cron reports as `order_already_used` rather than silently
  // mis-booking a financial record.
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS square_settled_order_id TEXT`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS gfq_square_settled_order
    ON group_function_quotes(square_settled_order_id)
    WHERE square_settled_order_id IS NOT NULL`;

  // One-time backfill of collected_cents for rows that predate the column.
  // Idempotent: guarded by collected_cents = 0, so it touches 0 rows after the first run.
  // Keyed on the actual money facts (not status): if the balance was paid, the whole total was
  // collected; otherwise a paid deposit collected (total - remaining balance).
  await q`
    UPDATE group_function_quotes SET collected_cents = total_cents
    WHERE balance_paid_at IS NOT NULL AND collected_cents = 0 AND total_cents > 0
  `;
  await q`
    UPDATE group_function_quotes SET collected_cents = GREATEST(0, total_cents - balance_cents)
    WHERE balance_paid_at IS NULL AND deposit_paid_at IS NOT NULL
      AND collected_cents = 0 AND total_cents > 0
  `;

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

  // Card-on-file display columns
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS saved_card_last4 TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS saved_card_brand TEXT`;

  // Contract version snapshots
  await q`
    CREATE TABLE IF NOT EXISTS contract_versions (
      id              BIGSERIAL PRIMARY KEY,
      quote_id        INTEGER NOT NULL,
      version_number  INTEGER NOT NULL,
      snapshot        JSONB NOT NULL,
      changes         JSONB DEFAULT '[]',
      trigger         TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS cv_quote ON contract_versions(quote_id)`;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS cv_quote_version ON contract_versions(quote_id, version_number)`;

  // ── $20 legacy win-back ──────────────────────────────────────────────
  // Ingested legacy deposit events that are offered the $20 "complete your
  // final payment" incentive. On payment they fully cut over to the new flow;
  // until then BMI keeps settling them the old way. The $20 is a separate
  // complimentary eGift card minted once, on successful payment.
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS is_winback BOOLEAN NOT NULL DEFAULT FALSE`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS incentive_cents INTEGER NOT NULL DEFAULT 0`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS incentive_gift_card_gan TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS incentive_gift_card_id TEXT`;
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS incentive_issued_at TIMESTAMPTZ`;
  // Retry selector: paid win-back events still awaiting their $20 mint.
  await q`CREATE INDEX IF NOT EXISTS gfq_winback_pending
    ON group_function_quotes(balance_paid_at)
    WHERE is_winback = TRUE AND incentive_issued_at IS NULL`;

  // ── Notification engine ──────────────────────────────────────────────
  // Per-quote suppression toggle, filterable in the reminder dispatcher.
  await q`ALTER TABLE group_function_quotes ADD COLUMN IF NOT EXISTS reminders_suppressed BOOLEAN NOT NULL DEFAULT FALSE`;
  // Structured send ledger. contract_audit_log remains the idempotency GATE
  // (NOT EXISTS dedup); this table records per-channel delivery detail for
  // admin visibility + provider message-id correlation.
  await q`
    CREATE TABLE IF NOT EXISTS group_event_notifications (
      id                  BIGSERIAL PRIMARY KEY,
      quote_id            INTEGER NOT NULL,
      rule_key            TEXT NOT NULL,
      dedup_key           TEXT NOT NULL,
      channel             TEXT NOT NULL,
      status              TEXT NOT NULL,
      provider            TEXT,
      provider_message_id TEXT,
      to_address          TEXT,
      error               TEXT,
      metadata            JSONB DEFAULT '{}',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS gen_quote ON group_event_notifications(quote_id)`;
  await q`CREATE INDEX IF NOT EXISTS gen_rule ON group_event_notifications(rule_key)`;
  await q`CREATE INDEX IF NOT EXISTS gen_created ON group_event_notifications(created_at)`;

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
  collected_cents: number;
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
  square_balance_link_id: string | null;
  balance_paid_at: string | null;
  balance_payment_method: string | null;
  balance_payment_link_url: string | null;
  balance_link_sent_at: string | null;
  square_dayof_order_id: string | null;
  square_settled_order_id: string | null;
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
  saved_card_last4: string | null;
  saved_card_brand: string | null;
  is_winback: boolean;
  incentive_cents: number;
  incentive_gift_card_gan: string | null;
  incentive_gift_card_id: string | null;
  incentive_issued_at: string | null;
  reminders_suppressed: boolean;
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
      is_tax_exempt, hermes_last_processed_at, status
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
      NOW(),
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
      AND (approval_required IS NULL OR approval_required = FALSE)
    ORDER BY event_date ASC
  `;
  return rows as GroupFunctionQuote[];
}

export async function getQuotesWithPendingBalanceLinks(): Promise<GroupFunctionQuote[]> {
  await ensureGfSchema();
  const q = sql();
  // Grace window past the event: a customer may pay the link the day of (or shortly after) the
  // event. We still need to reconcile + load the day-of gift cards. Bounded so long-abandoned
  // links eventually drop out of the poll.
  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE status = 'balance_link_sent'
      AND event_date > NOW() - INTERVAL '14 days'
    ORDER BY event_date ASC
  `;
  return rows as GroupFunctionQuote[];
}

/**
 * Candidate events that never finished our flow (`contract_sent` / `deposit_paid` /
 * `balance_link_sent`) but may have been settled directly in Square (a paid order
 * whose name starts with "BMI…"). group-square-settled-close verifies each against
 * Square before completing. The hard NOT-IN guardrail ensures a caller-supplied
 * `statuses` override can never reach into a terminal state, and `total_cents > 0`
 * drops degenerate rows where amount reconciliation is meaningless.
 */
export async function getQuotesStuckForBmiSettlement(opts?: {
  statuses?: GfQuoteStatus[];
  windowDays?: number;
  limit?: number;
}): Promise<GroupFunctionQuote[]> {
  await ensureGfSchema();
  const q = sql();
  const statuses = opts?.statuses ?? ["contract_sent", "deposit_paid", "balance_link_sent"];
  const windowDays = opts?.windowDays ?? 60;
  const limit = opts?.limit ?? 100;
  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE status = ANY(${statuses})
      AND status NOT IN ('completed', 'cancelled', 'denied', 'expired', 'resign_required')
      AND total_cents > 0
      AND square_location_id IS NOT NULL
      AND square_settled_order_id IS NULL
      AND event_date >= NOW() - (${windowDays} || ' days')::interval
      AND event_date <= NOW() + (${windowDays} || ' days')::interval
    ORDER BY event_date ASC
    LIMIT ${limit}
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
      collected_cents = GREATEST(0, total_cents - ${fields.balance_cents}),
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
      collected_cents = total_cents,
      status = 'balance_charged',
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Persist an expanded day-of gift-card list after a balance/reprice load overflowed
 * onto newly created cards (events over $2k/card). Same JSON-array shape the deposit
 * flow writes. Gans align by index with ids; a missing gan is stored as "".
 */
export async function updateGfGiftCardList(
  id: number,
  fields: { giftCardIds: string[]; giftCardGans: string[] },
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      square_gift_card_id = ${JSON.stringify(fields.giftCardIds)},
      square_gift_card_gan = ${JSON.stringify(fields.giftCardGans)},
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Full-prepay events (entire amount collected at deposit — booked within 96h — so the
 * gift card is already fully loaded) have no balance to charge. Advance them straight to
 * 'balance_charged' so the day-of payout + close crons pick them up. No Square balance
 * order/payment exists, so those columns stay null. Guarded to deposit_paid to avoid
 * clobbering any other state.
 */
export async function updateGfBalancePrepaid(id: number): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      balance_cents = 0,
      collected_cents = total_cents,
      balance_paid_at = COALESCE(balance_paid_at, NOW()),
      balance_payment_method = 'prepaid',
      status = 'balance_charged',
      updated_at = NOW()
    WHERE id = ${id} AND status = 'deposit_paid'
  `;
}

/**
 * Close an event that was settled directly in Square (a paid order named "BMI…"),
 * never through our flow. Books the money as fully collected (collected_cents =
 * total_cents, balance 0), records the settling Square order id, stamps the method
 * 'square', suppresses further reminders, and jumps status → 'completed'. Guarded on
 * non-terminal status so a re-run / race is an idempotent no-op (returns rowcount;
 * 1 = applied, 0 = already terminal). The $20 win-back incentive is intentionally
 * untouched — these guests settled in Square, they never took our new offer.
 *
 * NOTE: unlike the day-of close path, this does NOT pay/redeem any day-of gift card
 * (square_dayof_order_id is left as-is) — the money is already in via the Square
 * order, so there is nothing to fund.
 */
export async function markGfSquareSettledComplete(
  id: number,
  fields: { squareSettledOrderId: string },
): Promise<number> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    UPDATE group_function_quotes SET
      collected_cents = total_cents,
      balance_cents = 0,
      balance_paid_at = COALESCE(balance_paid_at, NOW()),
      balance_payment_method = 'square',
      reminders_suppressed = TRUE,
      square_settled_order_id = ${fields.squareSettledOrderId},
      status = 'completed',
      updated_at = NOW()
    WHERE id = ${id} AND status NOT IN ('completed', 'cancelled', 'denied', 'expired')
    RETURNING id
  `;
  return rows.length;
}

export async function updateGfBalanceLinkSent(
  id: number,
  fields: {
    balance_payment_link_url: string;
    balance_link_sent_at: string;
    balance_charge_attempts: number;
    balance_last_error?: string;
    /** Square payment-link id + its backing order id, captured so the reconcile poller can detect payment. */
    square_balance_link_id?: string;
    square_balance_order_id?: string;
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
      square_balance_link_id = COALESCE(${fields.square_balance_link_id ?? null}, square_balance_link_id),
      square_balance_order_id = COALESCE(${fields.square_balance_order_id ?? null}, square_balance_order_id),
      status = 'balance_link_sent',
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Settle a re-price delta on a paid-in-full event after the guest re-signs.
 * Advances resign_required → balance_charged, bumps collected_cents by the
 * charged delta, and (new-card path) records the saved card. Guarded on
 * resign_required so a duplicate settle call is a no-op.
 */
export async function updateGfRepriceCharged(
  id: number,
  fields: {
    collected_cents: number;
    saved_card_id?: string;
    saved_card_last4?: string;
    saved_card_brand?: string;
    square_customer_id?: string;
  },
): Promise<number> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    UPDATE group_function_quotes SET
      collected_cents = ${fields.collected_cents},
      balance_cents = 0,
      balance_paid_at = COALESCE(balance_paid_at, NOW()),
      saved_card_id = COALESCE(${fields.saved_card_id ?? null}, saved_card_id),
      saved_card_last4 = COALESCE(${fields.saved_card_last4 ?? null}, saved_card_last4),
      saved_card_brand = COALESCE(${fields.saved_card_brand ?? null}, saved_card_brand),
      square_customer_id = COALESCE(${fields.square_customer_id ?? null}, square_customer_id),
      status = 'balance_charged',
      updated_at = NOW()
    WHERE id = ${id} AND status = 'resign_required'
    RETURNING id
  `;
  return rows.length; // 1 = applied, 0 = already settled / not in resign_required
}

/**
 * Finalize a re-sign that needs no charge (deposit-only resign → deposit_paid,
 * or a paid-in-full event whose total didn't increase → balance_charged).
 * Guarded on resign_required for idempotency.
 */
export async function updateGfResignNoCharge(
  id: number,
  targetStatus: "deposit_paid" | "balance_charged",
): Promise<number> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    UPDATE group_function_quotes SET
      status = ${targetStatus},
      updated_at = NOW()
    WHERE id = ${id} AND status = 'resign_required'
    RETURNING id
  `;
  return rows.length;
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
    status?: string;
    contract_sent_at?: string | null;
    contract_status?: string | null;
    contract_short_id?: string | null;
    deposit_paid_at?: string | null;
    square_deposit_order_id?: string | null;
    square_deposit_payment_id?: string | null;
    square_gift_card_id?: string | null;
    square_gift_card_gan?: string | null;
    square_dayof_order_id?: string | null;
    signed_pdf_url?: string | null;
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
      status = CASE WHEN ${"status" in fields} THEN ${fields.status ?? null} ELSE status END,
      contract_sent_at = CASE WHEN ${"contract_sent_at" in fields} THEN ${fields.contract_sent_at ?? null}::timestamptz ELSE contract_sent_at END,
      contract_status = CASE WHEN ${"contract_status" in fields} THEN ${fields.contract_status ?? null} ELSE contract_status END,
      contract_short_id = CASE WHEN ${"contract_short_id" in fields} THEN ${fields.contract_short_id ?? null} ELSE contract_short_id END,
      deposit_paid_at = CASE WHEN ${"deposit_paid_at" in fields} THEN ${fields.deposit_paid_at ?? null}::timestamptz ELSE deposit_paid_at END,
      square_deposit_order_id = CASE WHEN ${"square_deposit_order_id" in fields} THEN ${fields.square_deposit_order_id ?? null} ELSE square_deposit_order_id END,
      square_deposit_payment_id = CASE WHEN ${"square_deposit_payment_id" in fields} THEN ${fields.square_deposit_payment_id ?? null} ELSE square_deposit_payment_id END,
      square_gift_card_id = CASE WHEN ${"square_gift_card_id" in fields} THEN ${fields.square_gift_card_id ?? null} ELSE square_gift_card_id END,
      square_gift_card_gan = CASE WHEN ${"square_gift_card_gan" in fields} THEN ${fields.square_gift_card_gan ?? null} ELSE square_gift_card_gan END,
      square_dayof_order_id = CASE WHEN ${"square_dayof_order_id" in fields} THEN ${fields.square_dayof_order_id ?? null} ELSE square_dayof_order_id END,
      signed_pdf_url = CASE WHEN ${"signed_pdf_url" in fields} THEN ${fields.signed_pdf_url ?? null} ELSE signed_pdf_url END,
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

// ── Win-back ingestion + incentive ──────────────────────────────────

/**
 * Promote a freshly-inserted row into a ready-to-OFFER legacy win-back quote.
 *
 * Card-on-file model: lands the row in `contract_sent` (NOT signed/deposit_paid)
 * so the guest re-confirms + adds a card via the existing /contract portal
 * legacy-deposit flow (`hasLegacyDeposit`/`cardOnFileOnly`). That flow records
 * the already-collected deposit (prior_payments) as a comp gift card, creates
 * the day-of order, and saves the card — then the standard 72h balance cron
 * charges it like any other event. `deposit_paid_at` stays NULL (and
 * `collected_cents` stays 0) until the guest adds a card; `balance_cents` is
 * the remaining amount we'll collect.
 */
export async function markGfQuoteIngestedWinback(
  id: number,
  fields: {
    contract_short_id: string;
    pandadoc_document_id?: string | null;
    contract_sent_at: string;
    deposit_due_cents: number;
    balance_cents: number;
    incentive_cents: number;
  },
): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    UPDATE group_function_quotes SET
      contract_short_id = ${fields.contract_short_id},
      pandadoc_document_id = COALESCE(${fields.pandadoc_document_id ?? null}, pandadoc_document_id),
      contract_status = 'sent',
      contract_sent_at = ${fields.contract_sent_at},
      deposit_due_cents = ${fields.deposit_due_cents},
      balance_cents = ${fields.balance_cents},
      is_winback = TRUE,
      incentive_cents = ${fields.incentive_cents},
      status = 'contract_sent',
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Record the issued $20 incentive gift card. Guarded on
 * `incentive_issued_at IS NULL` so a re-run never double-mints; returns rowcount
 * (1 = applied, 0 = already issued).
 */
export async function updateGfWinbackIncentiveIssued(
  id: number,
  fields: { gan: string; giftCardId: string },
): Promise<number> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    UPDATE group_function_quotes SET
      incentive_gift_card_gan = ${fields.gan},
      incentive_gift_card_id = ${fields.giftCardId},
      incentive_issued_at = NOW(),
      updated_at = NOW()
    WHERE id = ${id} AND incentive_issued_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/**
 * Win-back events that added a card on file but whose $20 card hasn't minted yet
 * (mint-retry sweep). The $20 is issued the moment the card is saved; this
 * catches a rare mint failure at that point.
 */
export async function getWinbackQuotesNeedingIncentive(): Promise<GroupFunctionQuote[]> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM group_function_quotes
    WHERE is_winback = TRUE
      AND saved_card_id IS NOT NULL
      AND incentive_issued_at IS NULL
    ORDER BY updated_at ASC
    LIMIT 50
  `;
  return rows as GroupFunctionQuote[];
}

// ── Notification ledger ─────────────────────────────────────────────

export async function recordEventNotification(params: {
  quoteId: number;
  ruleKey: string;
  dedupKey: string;
  channel: string;
  status: string;
  provider?: string;
  providerMessageId?: string;
  toAddress?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  await q`
    INSERT INTO group_event_notifications
      (quote_id, rule_key, dedup_key, channel, status, provider, provider_message_id, to_address, error, metadata)
    VALUES (
      ${params.quoteId}, ${params.ruleKey}, ${params.dedupKey}, ${params.channel}, ${params.status},
      ${params.provider ?? null}, ${params.providerMessageId ?? null}, ${params.toAddress ?? null},
      ${params.error ?? null}, ${JSON.stringify(params.metadata ?? {})}
    )
  `;
}

export interface EventNotification {
  id: number;
  quote_id: number;
  rule_key: string;
  dedup_key: string;
  channel: string;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  to_address: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function getEventNotifications(quoteId: number): Promise<EventNotification[]> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM group_event_notifications
    WHERE quote_id = ${quoteId}
    ORDER BY created_at ASC
  `;
  return rows as EventNotification[];
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

// ── Contract version snapshots ─────────────────────────────────────

export interface ContractSnapshot {
  event_name: string | null;
  event_number: string | null;
  event_date: string;
  event_date_display: string | null;
  guest_count: number | null;
  notes: string | null;
  guest_first_name: string;
  guest_last_name: string;
  guest_email: string;
  guest_phone: string | null;
  planner_first: string | null;
  planner_last: string | null;
  planner_email: string | null;
  planner_phone: string | null;
  total_cents: number;
  tax_cents: number;
  deposit_due_cents: number;
  balance_cents: number;
  line_items: unknown[];
}

export interface ContractVersion {
  id: number;
  quote_id: number;
  version_number: number;
  snapshot: ContractSnapshot;
  changes: string[];
  trigger: string;
  created_at: string;
}

export function extractContractSnapshot(quote: GroupFunctionQuote): ContractSnapshot {
  return {
    event_name: quote.event_name,
    event_number: quote.event_number,
    event_date: quote.event_date,
    event_date_display: quote.event_date_display,
    guest_count: quote.guest_count,
    notes: quote.notes,
    guest_first_name: quote.guest_first_name,
    guest_last_name: quote.guest_last_name,
    guest_email: quote.guest_email,
    guest_phone: quote.guest_phone,
    planner_first: quote.planner_first,
    planner_last: quote.planner_last,
    planner_email: quote.planner_email,
    planner_phone: quote.planner_phone,
    total_cents: quote.total_cents,
    tax_cents: quote.tax_cents,
    deposit_due_cents: quote.deposit_due_cents,
    balance_cents: quote.balance_cents,
    line_items: quote.line_items,
  };
}

export async function createContractVersion(params: {
  quoteId: number;
  snapshot: ContractSnapshot;
  changes?: string[];
  trigger: string;
}): Promise<void> {
  await ensureGfSchema();
  const q = sql();
  const nextVersion = await q`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS next
    FROM contract_versions WHERE quote_id = ${params.quoteId}
  `;
  const versionNumber = (nextVersion[0] as { next: number }).next;
  await q`
    INSERT INTO contract_versions (quote_id, version_number, snapshot, changes, trigger)
    VALUES (
      ${params.quoteId},
      ${versionNumber},
      ${JSON.stringify(params.snapshot)}::jsonb,
      ${JSON.stringify(params.changes ?? [])}::jsonb,
      ${params.trigger}
    )
  `;
}

export async function getContractVersions(quoteId: number): Promise<ContractVersion[]> {
  await ensureGfSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM contract_versions
    WHERE quote_id = ${quoteId}
    ORDER BY version_number ASC
  `;
  return rows as ContractVersion[];
}

export interface FieldDiff {
  field: string;
  label: string;
  before: string;
  after: string;
}

const FIELD_LABELS: Record<string, string> = {
  event_name: "Event Name",
  event_number: "Event Number",
  event_date_display: "Event Date",
  guest_count: "Guest Count",
  notes: "Notes",
  guest_first_name: "Guest First Name",
  guest_last_name: "Guest Last Name",
  guest_email: "Guest Email",
  guest_phone: "Guest Phone",
  planner_first: "Planner First Name",
  planner_last: "Planner Last Name",
  planner_email: "Planner Email",
  planner_phone: "Planner Phone",
  total_cents: "Total",
  tax_cents: "Tax",
  deposit_due_cents: "Deposit",
  balance_cents: "Balance",
  line_items: "Products",
};

function formatFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (field.endsWith("_cents") && typeof value === "number") {
    return `$${(value / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  }
  if (field === "line_items" && Array.isArray(value)) {
    return value
      .map(
        (li: { name?: string; qty?: number; total?: number }) =>
          `${li.name || "?"} x${li.qty ?? 1}`,
      )
      .join(", ");
  }
  return String(value);
}

export function diffSnapshots(a: ContractSnapshot, b: ContractSnapshot): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const key of Object.keys(FIELD_LABELS) as Array<keyof ContractSnapshot>) {
    if (key === "event_date") continue;
    const av = JSON.stringify(a[key]);
    const bv = JSON.stringify(b[key]);
    if (av !== bv) {
      diffs.push({
        field: key,
        label: FIELD_LABELS[key] || key,
        before: formatFieldValue(key, a[key]),
        after: formatFieldValue(key, b[key]),
      });
    }
  }
  return diffs;
}
