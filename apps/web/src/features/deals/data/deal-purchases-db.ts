/**
 * Deal-pack purchases (Neon) — the durable record of every prepaid pack sold.
 *
 * PERSIST-FIRST. A row exists in `pending` BEFORE any money moves, carrying the
 * buyer's name, email and phone. That ordering is a hard repo rule: anything a
 * guest hands us must be in our own DB at the moment of capture, independent of
 * the external call, so a Square failure never loses recoverable data. It also
 * makes the row the recovery anchor — a crash anywhere after the charge leaves a
 * `charged` row with no `voucher_batch_id`, which the reconcile cron finishes.
 *
 * THIS TABLE IS THE IDEMPOTENCY ANCHOR FOR A PAID MINT, and it has to be,
 * because the `vouchers` table has none for this case. `vouchers.bill_id` is the
 * only linkage column with a unique index and it exists for reservation-granted
 * vouchers (`mintBookingVoucherIfNeeded`); a purchased pack has no BMI bill. So
 * rather than adding payment columns to a shared, money-adjacent table, the
 * purchase row owns the money facts and links to the vouchers by
 * `voucher_batch_id` → `vouchers.batch_id` (a column that already exists and is
 * already indexed). `issued_source` on those rows reads `deal:<slug>`, so the
 * join works in both directions with zero schema churn on `vouchers`.
 *
 * The mint guard is therefore `voucher_batch_id IS NULL`, applied in a single
 * conditional UPDATE — never a read-then-write, or two cron passes could double
 * mint and hand out twice the value that was paid for.
 */

import { sql, isDbConfigured } from "@ft/db";
import { canonicalizePhone } from "@/lib/participant-contact";
import type { DealLocationKey } from "../catalog";

/**
 * pending       → row written, nothing charged yet
 * charged       → money captured; vouchers may not exist yet
 * minted        → vouchers exist (`voucher_batch_id` set)
 * sent          → the buyer has been emailed their codes
 * charge_failed → terminal; the card was declined or the charge threw
 *
 * Only `charged | minted | sent` count against a buyer's cap — a declined
 * attempt must never consume someone's allowance.
 */
export type DealPurchaseStatus = "pending" | "charged" | "minted" | "sent" | "charge_failed";

/** Statuses that represent money actually taken. */
export const PAID_STATUSES: readonly DealPurchaseStatus[] = ["charged", "minted", "sent"] as const;

export interface DealPurchaseRow {
  id: number;
  dealSlug: string;
  locationKey: DealLocationKey;
  /** Intercard center code the game-card value loads against (12 FM / 6 Naples). */
  centerCode: number;
  qty: number;
  unitPriceCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  buyerName: string | null;
  buyerEmail: string;
  /** E.164, or null when the buyer gave nothing usable. */
  buyerPhone: string | null;
  smsOptIn: boolean;
  status: DealPurchaseStatus;
  squareOrderId: string | null;
  squarePaymentId: string | null;
  idempotencyKey: string;
  /** Joins to `vouchers.batch_id`. Non-null ⇒ the mint already happened. */
  voucherBatchId: string | null;
  /** The minted codes, for the confirmation screen, resends and audit. */
  codes: string[];
  /** Ad attribution — utm_* + gclid off the landing URL. */
  utm: Record<string, string> | null;
  clickwrapVersion: string | null;
  lastError: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  createdAt: string;
  chargedAt: string | null;
  mintedAt: string | null;
  sentAt: string | null;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS deal_purchases (
        id BIGSERIAL PRIMARY KEY,
        deal_slug TEXT NOT NULL,
        location_key TEXT NOT NULL,
        center_code INTEGER NOT NULL,
        qty INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL,
        subtotal_cents INTEGER NOT NULL,
        tax_cents INTEGER NOT NULL,
        total_cents INTEGER NOT NULL,
        buyer_name TEXT,
        buyer_email TEXT NOT NULL,
        buyer_phone TEXT,
        sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'pending',
        square_order_id TEXT,
        square_payment_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        -- Joins to vouchers.batch_id. Also the mint guard: NULL means the
        -- vouchers for this purchase do not exist yet.
        voucher_batch_id TEXT,
        codes JSONB NOT NULL DEFAULT '[]'::jsonb,
        utm JSONB,
        clickwrap_version TEXT,
        last_error TEXT,
        refunded_at TIMESTAMPTZ,
        refund_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        charged_at TIMESTAMPTZ,
        minted_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ
      )
    `;
    // The cap query filters on deal + buyer identity. Two indexes rather than
    // one composite: the lookup is an OR across email and phone, so Postgres
    // needs to be able to use either side independently.
    await q`
      CREATE INDEX IF NOT EXISTS deal_purchases_buyer_email
      ON deal_purchases (deal_slug, lower(buyer_email))
    `;
    await q`
      CREATE INDEX IF NOT EXISTS deal_purchases_buyer_phone
      ON deal_purchases (deal_slug, buyer_phone) WHERE buyer_phone IS NOT NULL
    `;
    // The reconcile cron scans for unfinished paid work.
    await q`
      CREATE INDEX IF NOT EXISTS deal_purchases_unfinished
      ON deal_purchases (status, created_at) WHERE status IN ('charged', 'minted')
    `;
    await q`CREATE INDEX IF NOT EXISTS deal_purchases_batch ON deal_purchases (voucher_batch_id)`;
  })();
  return schemaReady;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function decode(r: any): DealPurchaseRow {
  const rawCodes = typeof r.codes === "string" ? JSON.parse(r.codes) : r.codes;
  return {
    id: Number(r.id),
    dealSlug: String(r.deal_slug),
    locationKey: String(r.location_key) as DealLocationKey,
    centerCode: Number(r.center_code),
    qty: Number(r.qty),
    unitPriceCents: Number(r.unit_price_cents),
    subtotalCents: Number(r.subtotal_cents),
    taxCents: Number(r.tax_cents),
    totalCents: Number(r.total_cents),
    buyerName: r.buyer_name ?? null,
    buyerEmail: String(r.buyer_email),
    buyerPhone: r.buyer_phone ?? null,
    smsOptIn: !!r.sms_opt_in,
    status: String(r.status) as DealPurchaseStatus,
    squareOrderId: r.square_order_id ?? null,
    squarePaymentId: r.square_payment_id ?? null,
    idempotencyKey: String(r.idempotency_key),
    voucherBatchId: r.voucher_batch_id ?? null,
    codes: Array.isArray(rawCodes) ? rawCodes.map(String) : [],
    utm: r.utm ?? null,
    clickwrapVersion: r.clickwrap_version ?? null,
    lastError: r.last_error ?? null,
    refundedAt: r.refunded_at ? new Date(r.refunded_at).toISOString() : null,
    refundReason: r.refund_reason ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    chargedAt: r.charged_at ? new Date(r.charged_at).toISOString() : null,
    mintedAt: r.minted_at ? new Date(r.minted_at).toISOString() : null,
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface InsertDealPurchaseArgs {
  dealSlug: string;
  locationKey: DealLocationKey;
  centerCode: number;
  qty: number;
  unitPriceCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  buyerName?: string | null;
  buyerEmail: string;
  buyerPhone?: string | null;
  smsOptIn?: boolean;
  idempotencyKey: string;
  utm?: Record<string, string> | null;
  clickwrapVersion?: string | null;
}

/**
 * Write the purchase intent. THROWS when the DB is unreachable — deliberately.
 * We must never charge a card for a pack we have no record of; a hard failure
 * here is a guest seeing "try again", which is recoverable. A soft failure would
 * be money taken against nothing.
 */
export async function insertDealPurchase(args: InsertDealPurchaseArgs): Promise<DealPurchaseRow> {
  if (!isDbConfigured()) {
    throw new Error("DB not configured — refusing to charge for an unpersisted deal purchase");
  }
  await ensureSchema();
  const q = sql();
  const rows = await q`
    INSERT INTO deal_purchases (
      deal_slug, location_key, center_code, qty,
      unit_price_cents, subtotal_cents, tax_cents, total_cents,
      buyer_name, buyer_email, buyer_phone, sms_opt_in,
      idempotency_key, utm, clickwrap_version
    ) VALUES (
      ${args.dealSlug}, ${args.locationKey}, ${args.centerCode}, ${args.qty},
      ${args.unitPriceCents}, ${args.subtotalCents}, ${args.taxCents}, ${args.totalCents},
      ${args.buyerName ?? null}, ${args.buyerEmail},
      ${canonicalizePhone(args.buyerPhone)}, ${args.smsOptIn ?? false},
      ${args.idempotencyKey}, ${args.utm ? JSON.stringify(args.utm) : null},
      ${args.clickwrapVersion ?? null}
    )
    RETURNING *
  `;
  return decode(rows[0]);
}

export async function getDealPurchase(id: number): Promise<DealPurchaseRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = await q`SELECT * FROM deal_purchases WHERE id = ${id}`;
  return rows[0] ? decode(rows[0]) : null;
}

/** Stamp the Square ids and flip to `charged`. */
export async function markDealPurchaseCharged(
  id: number,
  args: { squareOrderId: string | null; squarePaymentId: string | null },
): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE deal_purchases
    SET status = 'charged',
        square_order_id = ${args.squareOrderId},
        square_payment_id = ${args.squarePaymentId},
        charged_at = COALESCE(charged_at, NOW()),
        last_error = NULL
    WHERE id = ${id}
  `;
}

export async function markDealPurchaseChargeFailed(id: number, error: string): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE deal_purchases
    SET status = 'charge_failed', last_error = ${error.slice(0, 500)}
    WHERE id = ${id} AND status = 'pending'
  `;
}

/**
 * Record the mint — the one write that must never happen twice.
 *
 * Guarded by `voucher_batch_id IS NULL` inside the UPDATE rather than by a
 * preceding SELECT: the purchase route and the reconcile cron can both be
 * looking at the same `charged` row, and a read-then-write would let both mint.
 * Returns false when another writer already claimed it, which tells the caller
 * to VOID what it just minted rather than emailing a second set of codes.
 */
export async function markDealPurchaseMinted(
  id: number,
  args: { batchId: string; codes: string[] },
): Promise<boolean> {
  await ensureSchema();
  const q = sql();
  const rows = await q`
    UPDATE deal_purchases
    SET status = 'minted',
        voucher_batch_id = ${args.batchId},
        codes = ${JSON.stringify(args.codes)}::jsonb,
        minted_at = NOW()
    WHERE id = ${id} AND voucher_batch_id IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

export async function markDealPurchaseSent(id: number): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE deal_purchases
    SET status = 'sent', sent_at = NOW()
    WHERE id = ${id} AND voucher_batch_id IS NOT NULL
  `;
}

export async function recordDealPurchaseError(id: number, error: string): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`UPDATE deal_purchases SET last_error = ${error.slice(0, 500)} WHERE id = ${id}`;
}

export async function markDealPurchaseRefunded(id: number, reason: string): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE deal_purchases
    SET refunded_at = NOW(), refund_reason = ${reason.slice(0, 500)}
    WHERE id = ${id}
  `;
}

/**
 * How many packs of THIS deal a buyer already holds, all time.
 *
 * Identity is email OR phone, because a determined buyer will vary one of them.
 * Refunded purchases don't count — a refund gives the allowance back. Neither do
 * declines (`charge_failed`) or abandoned attempts (`pending`), which is why the
 * status filter is an allowlist rather than "not failed": a `pending` row is a
 * card form someone opened and walked away from, and it must not consume a slot.
 */
export async function countPacksForBuyer(args: {
  dealSlug: string;
  email: string;
  phone?: string | null;
}): Promise<number> {
  if (!isDbConfigured()) {
    throw new Error("DB not configured — cannot enforce the per-buyer cap");
  }
  await ensureSchema();
  const q = sql();
  const email = args.email.trim().toLowerCase();
  const phone = canonicalizePhone(args.phone);
  const paid = [...PAID_STATUSES];
  // Branch in JS rather than casting a possibly-null parameter inside SQL — the
  // two queries are clearer than one with a dead OR arm, and it keeps the
  // phone index usable.
  const rows = phone
    ? await q`
        SELECT COALESCE(SUM(qty), 0)::int AS packs
        FROM deal_purchases
        WHERE deal_slug = ${args.dealSlug}
          AND status = ANY(${paid})
          AND refunded_at IS NULL
          AND (lower(buyer_email) = ${email} OR buyer_phone = ${phone})
      `
    : await q`
        SELECT COALESCE(SUM(qty), 0)::int AS packs
        FROM deal_purchases
        WHERE deal_slug = ${args.dealSlug}
          AND status = ANY(${paid})
          AND refunded_at IS NULL
          AND lower(buyer_email) = ${email}
      `;
  return Number(rows[0]?.packs ?? 0);
}

/**
 * Paid purchases the cron still owes work on: `charged` with no vouchers, or
 * `minted` but never emailed. `olderThanSeconds` keeps the cron off rows the
 * live request is still working through.
 */
export async function listUnfinishedDealPurchases(
  olderThanSeconds = 120,
  limit = 50,
): Promise<DealPurchaseRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM deal_purchases
    WHERE status IN ('charged', 'minted')
      AND refunded_at IS NULL
      AND created_at < NOW() - (${olderThanSeconds} * INTERVAL '1 second')
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
  return rows.map(decode);
}

/** Newest-first list for the admin board. */
export async function listDealPurchases(args: {
  dealSlug?: string;
  limit?: number;
}): Promise<DealPurchaseRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const limit = Math.min(500, Math.max(1, args.limit ?? 200));
  const rows = args.dealSlug
    ? await q`
        SELECT * FROM deal_purchases WHERE deal_slug = ${args.dealSlug}
        ORDER BY created_at DESC LIMIT ${limit}
      `
    : await q`SELECT * FROM deal_purchases ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(decode);
}
