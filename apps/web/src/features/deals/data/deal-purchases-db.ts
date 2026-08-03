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
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";
import type { DealLocationKey } from "../catalog";

/**
 * pending       → row written, nothing charged yet
 * charged       → money captured; vouchers may not exist yet
 * minted        → vouchers exist (`voucher_batch_id` set)
 * scheduled     → GIFTS ONLY: codes exist, the buyer has their receipt, and the
 *                 recipient is waiting on `gift_send_at`
 * sent          → the codes reached whoever they were bought for
 * charge_failed → terminal; the card was declined or the charge threw
 *
 * `scheduled` is a real state rather than "minted with a future date" because the
 * reconcile sweep scans on status: a gift sitting in `minted` for eleven weeks
 * would be picked up as unfinished work on every single pass. See
 * `listUnfinishedDealPurchases`.
 *
 * Everything except `pending` and `charge_failed` counts against a buyer's cap —
 * a declined attempt must never consume someone's allowance, but a gift bought
 * for December absolutely does.
 */
export type DealPurchaseStatus =
  | "pending"
  | "charged"
  | "minted"
  | "scheduled"
  | "sent"
  | "charge_failed";

/** Statuses that represent money actually taken. */
export const PAID_STATUSES: readonly DealPurchaseStatus[] = [
  "charged",
  "minted",
  "scheduled",
  "sent",
] as const;

export interface DealPurchaseRow {
  id: number;
  dealSlug: string;
  locationKey: DealLocationKey;
  /** Intercard center code the game-card value loads against (12 FM / 6 Naples). */
  centerCode: number;
  qty: number;
  /** TRUE = one voucher carrying all `qty` packs. FALSE = one voucher per pack
   *  (only wanted when the packs go to different people). */
  combine: boolean;
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
  /** TRUE when this was bought for somebody else. Drives who gets the codes. */
  isGift: boolean;
  recipientName: string | null;
  recipientEmail: string | null;
  /** E.164, or null — a gift recipient's number is always optional. */
  recipientPhone: string | null;
  /** The buyer's note to the recipient, shown in the gift email + text. */
  giftMessage: string | null;
  /** When the recipient should hear about it. NULL = with the purchase. */
  giftSendAt: string | null;
  /** When the recipient actually got it. */
  giftSentAt: string | null;
  /** Ad attribution — utm_* + gclid off the landing URL. */
  utm: Record<string, string> | null;
  clickwrapVersion: string | null;
  lastError: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  /** When the abandoned-checkout recovery email went out. Non-null ⇒ never again. */
  abandonEmailSentAt: string | null;
  /** The limited offer's bonus items as they stood AT PURCHASE, per pack.
   *  Fulfilment reads this, never the catalog — see the ALTER in ensureSchema. */
  bonusItems: VoucherItem[];
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
    // Added after the table shipped, so it MUST be an ALTER — the CREATE above is
    // IF NOT EXISTS and never runs again on an existing table. Defaults TRUE: one
    // code for one buyer is the default, and the fulfilment path reads this column
    // (not the request) so a cron re-run mints the same shape.
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS combine BOOLEAN NOT NULL DEFAULT TRUE`;
    // Gifting, added 2026-08-03. Same ALTER reasoning as `combine` above.
    // `gift_send_at` NULL on a gift means "went out with the purchase"; a future
    // value is the only thing that puts a row in `scheduled`.
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS is_gift BOOLEAN NOT NULL DEFAULT FALSE`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS recipient_name TEXT`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS recipient_email TEXT`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS recipient_phone TEXT`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS gift_message TEXT`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS gift_send_at TIMESTAMPTZ`;
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS gift_sent_at TIMESTAMPTZ`;
    // Same reason it must be an ALTER. Stamped when the abandoned-checkout
    // recovery email goes out, and the only thing stopping a second one — a
    // guest who walked away from a card form has not asked to hear from us
    // twice.
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS abandon_email_sent_at TIMESTAMPTZ`;
    // The limited offer's bonus items, FROZEN AT PURCHASE. Fulfilment reads this
    // column and never re-derives from the catalog: the reconcile cron can mint
    // long after the charge, by which point the offer may have ended, and a
    // buyer who paid while it was running is owed the bonus whenever our cron
    // gets round to it. Exactly why `combine` is a column too.
    await q`ALTER TABLE deal_purchases ADD COLUMN IF NOT EXISTS bonus_items JSONB NOT NULL DEFAULT '[]'::jsonb`;
    // The launch-allocation counter runs on every quote, so it gets its own
    // index rather than riding the buyer-identity ones (which lead with
    // lower(buyer_email) and are useless for a whole-deal SUM).
    await q`
      CREATE INDEX IF NOT EXISTS deal_purchases_sold
      ON deal_purchases (deal_slug, status) WHERE refunded_at IS NULL
    `;
    // The recovery sweep scans pending rows in a narrow age window.
    await q`
      CREATE INDEX IF NOT EXISTS deal_purchases_abandoned
      ON deal_purchases (created_at) WHERE status = 'pending' AND abandon_email_sent_at IS NULL
    `;
    // The dispatch sweep's only query: due gifts, oldest first.
    await q`
      CREATE INDEX IF NOT EXISTS deal_purchases_gift_due
      ON deal_purchases (gift_send_at) WHERE status = 'scheduled'
    `;
  })();
  return schemaReady;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Bonus items off the row.
 *
 * Falls back to an empty list on anything unreadable rather than throwing. This
 * column is read on the fulfilment path, and a row that cannot be decoded must
 * still mint the pack the buyer definitely paid for — losing a bonus is
 * recoverable by hand, refusing to mint anything at all is not.
 */
function decodeBonusItems(raw: unknown): VoucherItem[] {
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  return Array.isArray(parsed) ? (parsed as VoucherItem[]) : [];
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function decode(r: any): DealPurchaseRow {
  const rawCodes = typeof r.codes === "string" ? JSON.parse(r.codes) : r.codes;
  return {
    id: Number(r.id),
    dealSlug: String(r.deal_slug),
    locationKey: String(r.location_key) as DealLocationKey,
    centerCode: Number(r.center_code),
    qty: Number(r.qty),
    combine: r.combine !== false,
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
    isGift: !!r.is_gift,
    recipientName: r.recipient_name ?? null,
    recipientEmail: r.recipient_email ?? null,
    recipientPhone: r.recipient_phone ?? null,
    giftMessage: r.gift_message ?? null,
    giftSendAt: r.gift_send_at ? new Date(r.gift_send_at).toISOString() : null,
    giftSentAt: r.gift_sent_at ? new Date(r.gift_sent_at).toISOString() : null,
    utm: r.utm ?? null,
    clickwrapVersion: r.clickwrap_version ?? null,
    lastError: r.last_error ?? null,
    refundedAt: r.refunded_at ? new Date(r.refunded_at).toISOString() : null,
    refundReason: r.refund_reason ?? null,
    abandonEmailSentAt: r.abandon_email_sent_at
      ? new Date(r.abandon_email_sent_at).toISOString()
      : null,
    bonusItems: decodeBonusItems(r.bonus_items),
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
  combine?: boolean;
  /** The live offer's bonus items, per pack. Frozen onto the row at insert. */
  bonusItems?: VoucherItem[];
  unitPriceCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  buyerName?: string | null;
  buyerEmail: string;
  buyerPhone?: string | null;
  smsOptIn?: boolean;
  idempotencyKey: string;
  isGift?: boolean;
  recipientName?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  giftMessage?: string | null;
  /** ISO instant, already resolved from the buyer's chosen date. */
  giftSendAt?: string | null;
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
      deal_slug, location_key, center_code, qty, combine,
      unit_price_cents, subtotal_cents, tax_cents, total_cents,
      buyer_name, buyer_email, buyer_phone, sms_opt_in,
      idempotency_key, utm, clickwrap_version, bonus_items,
      is_gift, recipient_name, recipient_email, recipient_phone,
      gift_message, gift_send_at
    ) VALUES (
      ${args.dealSlug}, ${args.locationKey}, ${args.centerCode}, ${args.qty}, ${args.combine ?? true},
      ${args.unitPriceCents}, ${args.subtotalCents}, ${args.taxCents}, ${args.totalCents},
      ${args.buyerName ?? null}, ${args.buyerEmail},
      ${canonicalizePhone(args.buyerPhone)}, ${args.smsOptIn ?? false},
      ${args.idempotencyKey}, ${args.utm ? JSON.stringify(args.utm) : null},
      ${args.clickwrapVersion ?? null}, ${JSON.stringify(args.bonusItems ?? [])},
      ${args.isGift ?? false}, ${args.recipientName ?? null}, ${args.recipientEmail ?? null},
      ${canonicalizePhone(args.recipientPhone)}, ${args.giftMessage ?? null},
      ${args.giftSendAt ?? null}
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
    SET status = 'sent',
        sent_at = NOW(),
        -- On a gift this IS the recipient delivery, so stamp both. COALESCE so a
        -- re-run never rewrites the original delivery time.
        gift_sent_at = CASE WHEN is_gift THEN COALESCE(gift_sent_at, NOW()) ELSE gift_sent_at END
    WHERE id = ${id} AND voucher_batch_id IS NOT NULL
  `;
}

/**
 * Park a gift until its send date: codes exist, the buyer has been receipted,
 * the recipient hasn't been told yet.
 *
 * Guarded on `gift_send_at IS NOT NULL` so this can never strand a non-gift (or
 * a send-now gift) in a state nothing sweeps — `scheduled` is only reachable when
 * there is a date to wake up on. Returns false if the guard rejected, which the
 * caller treats as "leave it in `minted` and let reconcile try again".
 */
export async function markDealPurchaseScheduled(id: number): Promise<boolean> {
  await ensureSchema();
  const q = sql();
  const rows = await q`
    UPDATE deal_purchases
    SET status = 'scheduled', sent_at = COALESCE(sent_at, NOW())
    WHERE id = ${id}
      AND voucher_batch_id IS NOT NULL
      AND is_gift
      AND gift_send_at IS NOT NULL
      AND status IN ('charged', 'minted')
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Scheduled gifts whose day has come.
 *
 * The `gift_send_at <= NOW()` comparison is the ONLY thing that releases a gift,
 * and it lives in SQL rather than in JS so a clock-skewed serverless instance
 * can't decide it's Christmas early.
 */
export async function listDueGiftDeliveries(limit = 50): Promise<DealPurchaseRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM deal_purchases
    WHERE status = 'scheduled'
      AND refunded_at IS NULL
      AND gift_send_at IS NOT NULL
      AND gift_send_at <= NOW()
    ORDER BY gift_send_at ASC
    LIMIT ${limit}
  `;
  return rows.map(decode);
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
 * How many packs of this deal have been sold, all time — the launch-allocation
 * counter.
 *
 * Same status allowlist as `countPacksForBuyer`, and for the same reasons: a
 * `pending` row is a card form somebody opened and walked away from, a
 * `charge_failed` is a decline, and a refund gives the pack back. Counting any
 * of them would burn through an advertised allocation without a sale behind it,
 * which is the fake-scarcity failure mode in reverse — the counter would be
 * lying about a limit we had not actually reached.
 *
 * Returns 0 rather than throwing when the DB is unreachable. That is the SAFE
 * direction here and the opposite of the cap query's choice: an unreadable DB
 * means we keep honouring the launch price we advertised, rather than silently
 * charging everyone the higher one. The cap throws because failing open there
 * gives away unlimited packs; failing open here only ever costs us the discount
 * we already promised.
 */
export async function countPacksSold(dealSlug: string): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureSchema();
  const q = sql();
  const paid = [...PAID_STATUSES];
  const rows = await q`
    SELECT COALESCE(SUM(qty), 0)::int AS packs
    FROM deal_purchases
    WHERE deal_slug = ${dealSlug}
      AND status = ANY(${paid})
      AND refunded_at IS NULL
  `;
  return Number(rows[0]?.packs ?? 0);
}

/**
 * Abandoned checkouts worth one recovery email.
 *
 * A `pending` row is the persist-first record of somebody who typed their name,
 * email and phone into the buy panel and then did not complete — we already
 * hold every one of them, and until now did nothing with any of them.
 *
 * THE EXCLUSION THAT MATTERS: a decline creates a `pending` row and the retry
 * creates ANOTHER one, so the same person can be sitting in here with a
 * completed purchase alongside. Filtering on row status alone would email people
 * who bought — the single most damaging thing this sweep could do. The NOT
 * EXISTS clause is matched on email for the same deal, which is also what makes
 * the sweep idempotent across a buyer's own repeated attempts.
 *
 * The age window is deliberately narrow at both ends: younger than `minAgeHours`
 * and they may still be finishing, older than `maxAgeHours` and an email about
 * a checkout they have forgotten reads as spam rather than a nudge.
 */
export async function listAbandonedDealPurchases(args: {
  minAgeHours?: number;
  maxAgeHours?: number;
  limit?: number;
} = {}): Promise<DealPurchaseRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const minAge = args.minAgeHours ?? 1;
  const maxAge = args.maxAgeHours ?? 24;
  const limit = args.limit ?? 50;
  const paid = [...PAID_STATUSES];
  const rows = await q`
    SELECT p.* FROM deal_purchases p
    WHERE p.status = 'pending'
      AND p.abandon_email_sent_at IS NULL
      AND p.created_at < NOW() - (${minAge} * INTERVAL '1 hour')
      AND p.created_at > NOW() - (${maxAge} * INTERVAL '1 hour')
      AND NOT EXISTS (
        SELECT 1 FROM deal_purchases done
        WHERE done.deal_slug = p.deal_slug
          AND lower(done.buyer_email) = lower(p.buyer_email)
          AND done.status = ANY(${paid})
          AND done.refunded_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM deal_purchases mailed
        WHERE mailed.deal_slug = p.deal_slug
          AND lower(mailed.buyer_email) = lower(p.buyer_email)
          AND mailed.abandon_email_sent_at IS NOT NULL
      )
    ORDER BY p.created_at ASC
    LIMIT ${limit}
  `;
  return rows.map(decode);
}

/**
 * Claim a row for the recovery email, atomically.
 *
 * A conditional UPDATE rather than read-then-write, the same fence the mint
 * uses: two overlapping cron passes would otherwise both select the same row and
 * both send. Returns false when someone else got there first, and the caller
 * skips rather than sends.
 */
export async function claimAbandonEmail(id: number): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureSchema();
  const q = sql();
  const rows = await q`
    UPDATE deal_purchases
    SET abandon_email_sent_at = NOW()
    WHERE id = ${id} AND abandon_email_sent_at IS NULL AND status = 'pending'
    RETURNING id
  `;
  return rows.length > 0;
}

/** Undo a claim whose send then failed, so the next pass can retry it. */
export async function releaseAbandonEmail(id: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`UPDATE deal_purchases SET abandon_email_sent_at = NULL WHERE id = ${id}`;
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

/**
 * The purchase a voucher batch belongs to, if any.
 *
 * This is the SAFETY GATE for showing a voucher's batch siblings on the public
 * `/v/{code}` page. `vouchers.batch_id` also groups an admin comp mint — one
 * batch can be 500 codes destined for 500 different people — so listing siblings
 * off the batch alone would hand whoever holds one code everybody else's bearer
 * instruments. A purchase row means the batch was bought by ONE buyer, which is
 * the only case where the other codes are legitimately theirs to see.
 */
export async function getDealPurchaseByBatchId(batchId: string): Promise<DealPurchaseRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM deal_purchases WHERE voucher_batch_id = ${batchId} LIMIT 1
  `;
  return rows[0] ? decode(rows[0]) : null;
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
