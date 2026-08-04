/**
 * The deal-refund ledger — one row per refund ATTEMPT, not per purchase.
 *
 * A CHILD TABLE, not columns on `deal_purchases`, for four reasons:
 *
 *  1. Partial and repeated refunds are inherently 1:N. Columns cannot hold N.
 *  2. Each destination owns a different set of immutable Square objects: the
 *     card path has a return order and a refund; the gift-card path has a minted
 *     card, a GAN and a refund. Flattening those onto the purchase means either
 *     nullable-column soup or overwriting the first refund's audit trail.
 *  3. A retry has to NET OUT what a crashed attempt already issued.
 *     `refundTenderPartial` clamps only to the PAYMENT's un-refunded remainder,
 *     which is still large after a partial — without a per-attempt row, a re-run
 *     double-refunds.
 *  4. The row is where `seq` is allocated, and `seq` owns the idempotency-key
 *     namespace. That allocation has to be a durable, uniquely-constrained write
 *     BEFORE any Square call, or a retry cannot re-derive the same key.
 *
 * PERSIST-FIRST, then move money, then persist the result. Every external id is
 * written the moment it exists, so a crash between "Square did it" and "we know
 * Square did it" is recoverable by replaying the same key.
 */

import { sql, isDbConfigured } from "@ft/db";
import { ensureDealMoneyColumns } from "./deal-purchases-money";

/**
 * planned    row allocated, nothing external has happened
 * held       the voucher legs are claimed for this refund (value frozen)
 * returning  a Square return order exists (card path)
 * refunding  a destination gift card exists (gift-card path)
 * crediting  the refund is issued and we are waiting for the credit to land
 * settled    terminal, money moved
 * failed     terminal, money did NOT move; any held legs were released
 */
export type DealRefundState =
  | "planned"
  | "held"
  | "returning"
  | "refunding"
  | "crediting"
  | "settled"
  | "failed";

export type DealRefundDestination = "card" | "gift_card";

/** Non-terminal states the sweep resumes. */
export const OPEN_REFUND_STATES: readonly DealRefundState[] = [
  "planned",
  "held",
  "returning",
  "refunding",
  "crediting",
] as const;

export interface DealRefundRow {
  id: number;
  purchaseId: number;
  seq: number;
  refundKey: string;
  destination: DealRefundDestination;
  packs: number;
  packIndexes: number[];
  plannedCents: number;
  refundedCents: number;
  reason: string;
  actor: string;
  state: DealRefundState;
  squareReturnOrderId: string | null;
  squareRefundId: string | null;
  squareRefundStatus: string | null;
  destinationGiftCardId: string | null;
  destinationGiftCardGan: string | null;
  heldLegs: Record<string, number[]>;
  holdTxnId: string | null;
  voidedCodes: string[];
  planHash: string | null;
  spentOverride: boolean;
  lastError: string | null;
  createdAt: string;
  settledAt: string | null;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    // The projection columns live on `deal_purchases`; guarantee they exist
    // before anything here tries to recompute them.
    await ensureDealMoneyColumns();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS deal_refunds (
        id BIGSERIAL PRIMARY KEY,
        purchase_id BIGINT NOT NULL,
        -- 1-based per purchase. Owns the Square idempotency-key namespace, so it
        -- must be allocated durably and never reused by a retry.
        seq INTEGER NOT NULL,
        refund_key TEXT NOT NULL UNIQUE,
        destination TEXT NOT NULL,
        packs INTEGER NOT NULL,
        pack_indexes JSONB NOT NULL DEFAULT '[]'::jsonb,
        planned_cents INTEGER NOT NULL,
        refunded_cents INTEGER NOT NULL DEFAULT 0,
        -- STAFF free text. Never sent to Square; the Square reason is a pinned
        -- constant because refund reasons are immutable accounting keys.
        reason TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'admin',
        state TEXT NOT NULL DEFAULT 'planned',
        square_return_order_id TEXT,
        square_refund_id TEXT,
        square_refund_status TEXT,
        destination_gift_card_id TEXT,
        destination_gift_card_gan TEXT,
        held_legs JSONB NOT NULL DEFAULT '{}'::jsonb,
        hold_txn_id TEXT,
        voided_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
        plan_hash TEXT,
        spent_override BOOLEAN NOT NULL DEFAULT FALSE,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMPTZ,
        UNIQUE (purchase_id, seq)
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS deal_refunds_purchase ON deal_refunds (purchase_id)`;
    await q`
      CREATE INDEX IF NOT EXISTS deal_refunds_refund_id
      ON deal_refunds (square_refund_id) WHERE square_refund_id IS NOT NULL
    `;
    await q`
      CREATE INDEX IF NOT EXISTS deal_refunds_open
      ON deal_refunds (state, created_at)
      WHERE state NOT IN ('settled', 'failed')
    `;
  })();
  return schemaReady;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function decode(r: any): DealRefundRow {
  const json = (v: unknown, fallback: unknown) =>
    typeof v === "string" ? JSON.parse(v) : (v ?? fallback);
  return {
    id: Number(r.id),
    purchaseId: Number(r.purchase_id),
    seq: Number(r.seq),
    refundKey: String(r.refund_key),
    destination: String(r.destination) as DealRefundDestination,
    packs: Number(r.packs),
    packIndexes: json(r.pack_indexes, []) as number[],
    plannedCents: Number(r.planned_cents),
    refundedCents: Number(r.refunded_cents ?? 0),
    reason: String(r.reason),
    actor: String(r.actor),
    state: String(r.state) as DealRefundState,
    squareReturnOrderId: r.square_return_order_id ?? null,
    squareRefundId: r.square_refund_id ?? null,
    squareRefundStatus: r.square_refund_status ?? null,
    destinationGiftCardId: r.destination_gift_card_id ?? null,
    destinationGiftCardGan: r.destination_gift_card_gan ?? null,
    heldLegs: json(r.held_legs, {}) as Record<string, number[]>,
    holdTxnId: r.hold_txn_id ?? null,
    voidedCodes: json(r.voided_codes, []) as string[],
    planHash: r.plan_hash ?? null,
    spentOverride: !!r.spent_override,
    lastError: r.last_error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every refund attempt on a purchase, oldest first. */
export async function listDealRefunds(purchaseId: number): Promise<DealRefundRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM deal_refunds WHERE purchase_id = ${purchaseId} ORDER BY seq ASC
  `) as Record<string, unknown>[];
  return rows.map(decode);
}

export async function getDealRefund(id: number): Promise<DealRefundRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`SELECT * FROM deal_refunds WHERE id = ${id}`) as Record<string, unknown>[];
  return rows[0] ? decode(rows[0]) : null;
}

/**
 * Allocate an attempt.
 *
 * `seq` is `MAX(seq) + 1` computed inside the INSERT, and `UNIQUE (purchase_id,
 * seq)` is what makes that safe: two concurrent allocations cannot both win, and
 * the loser is told so rather than silently sharing an idempotency namespace with
 * the winner. THROWS when the DB is unreachable — a refund with no ledger row has
 * no recoverable key, so it must not proceed.
 */
export async function insertDealRefund(args: {
  purchaseId: number;
  refundKeyFor: (seq: number) => string;
  destination: DealRefundDestination;
  packs: number;
  packIndexes: number[];
  plannedCents: number;
  reason: string;
  actor: string;
  planHash: string;
  spentOverride: boolean;
  holdTxnFor: (refundKey: string) => string;
}): Promise<DealRefundRow> {
  if (!isDbConfigured()) {
    throw new Error("DB not configured — refusing to refund without a ledger row");
  }
  await ensureSchema();
  const q = sql();

  const next = (await q`
    SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM deal_refunds WHERE purchase_id = ${args.purchaseId}
  `) as Record<string, unknown>[];
  const seq = Number(next[0]?.seq ?? 1);
  const refundKey = args.refundKeyFor(seq);

  const rows = (await q`
    INSERT INTO deal_refunds (
      purchase_id, seq, refund_key, destination, packs, pack_indexes,
      planned_cents, reason, actor, plan_hash, spent_override, hold_txn_id
    ) VALUES (
      ${args.purchaseId}, ${seq}, ${refundKey}, ${args.destination}, ${args.packs},
      ${JSON.stringify(args.packIndexes)}::jsonb, ${args.plannedCents}, ${args.reason.slice(0, 300)},
      ${args.actor}, ${args.planHash}, ${args.spentOverride}, ${args.holdTxnFor(refundKey)}
    )
    RETURNING *
  `) as Record<string, unknown>[];
  return decode(rows[0]);
}

/** Patch an attempt as it progresses. Every external id lands the moment it exists. */
export async function updateDealRefund(
  id: number,
  patch: Partial<{
    state: DealRefundState;
    refundedCents: number;
    squareReturnOrderId: string | null;
    squareRefundId: string | null;
    squareRefundStatus: string | null;
    destinationGiftCardId: string | null;
    destinationGiftCardGan: string | null;
    heldLegs: Record<string, number[]>;
    voidedCodes: string[];
    lastError: string | null;
    settledAt: boolean;
  }>,
): Promise<void> {
  await ensureSchema();
  const q = sql();
  // One statement with COALESCE rather than a dynamic SET list: the Neon HTTP
  // driver runs each statement as its own transaction, so fewer statements means
  // fewer partial states to reason about after a crash.
  await q`
    UPDATE deal_refunds SET
      state = COALESCE(${patch.state ?? null}, state),
      refunded_cents = COALESCE(${patch.refundedCents ?? null}, refunded_cents),
      square_return_order_id = COALESCE(${patch.squareReturnOrderId ?? null}, square_return_order_id),
      square_refund_id = COALESCE(${patch.squareRefundId ?? null}, square_refund_id),
      square_refund_status = COALESCE(${patch.squareRefundStatus ?? null}, square_refund_status),
      destination_gift_card_id = COALESCE(${patch.destinationGiftCardId ?? null}, destination_gift_card_id),
      destination_gift_card_gan = COALESCE(${patch.destinationGiftCardGan ?? null}, destination_gift_card_gan),
      held_legs = COALESCE(${patch.heldLegs ? JSON.stringify(patch.heldLegs) : null}::jsonb, held_legs),
      voided_codes = COALESCE(${patch.voidedCodes ? JSON.stringify(patch.voidedCodes) : null}::jsonb, voided_codes),
      last_error = CASE WHEN ${patch.lastError === null} THEN NULL
                        ELSE COALESCE(${patch.lastError ?? null}, last_error) END,
      settled_at = CASE WHEN ${patch.settledAt === true} THEN COALESCE(settled_at, NOW()) ELSE settled_at END
    WHERE id = ${id}
  `;
}

/**
 * Recompute the purchase's projection FROM the ledger.
 *
 * Never an increment. A replayed settle must not double-count, and summing the
 * settled rows is idempotent by construction where `refunded_packs = refunded_packs
 * + n` is not.
 */
export async function recomputeDealRefundTotals(purchaseId: number): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE deal_purchases p SET
      refunded_packs = agg.packs,
      refunded_cents = agg.cents,
      fully_refunded_at = CASE WHEN agg.packs >= p.qty
                               THEN COALESCE(p.fully_refunded_at, NOW())
                               ELSE NULL END
    FROM (
      SELECT COALESCE(SUM(packs), 0)::int AS packs,
             COALESCE(SUM(refunded_cents), 0)::int AS cents
      FROM deal_refunds
      WHERE purchase_id = ${purchaseId} AND state = 'settled'
    ) agg
    WHERE p.id = ${purchaseId}
  `;
}

/**
 * An attempt already in flight on this purchase, if any.
 *
 * Two staff refunding the same purchase at once is the scenario this exists for.
 * The 48-hour window means a row abandoned by a crash eventually stops blocking
 * new work, rather than wedging the purchase forever.
 */
export async function getOpenDealRefund(purchaseId: number): Promise<DealRefundRow | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const open = [...OPEN_REFUND_STATES];
  const rows = (await q`
    SELECT * FROM deal_refunds
    WHERE purchase_id = ${purchaseId}
      AND state = ANY(${open}::text[])
      AND created_at > NOW() - INTERVAL '48 hours'
    ORDER BY seq DESC LIMIT 1
  `) as Record<string, unknown>[];
  return rows[0] ? decode(rows[0]) : null;
}

/** Non-terminal attempts the sweep should drive forward. */
export async function listStalledDealRefunds(
  olderThanSeconds = 120,
  limit = 25,
): Promise<DealRefundRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const open = [...OPEN_REFUND_STATES];
  const rows = (await q`
    SELECT * FROM deal_refunds
    WHERE state = ANY(${open}::text[])
      AND created_at < NOW() - (${olderThanSeconds} * INTERVAL '1 second')
    ORDER BY created_at ASC LIMIT ${limit}
  `) as Record<string, unknown>[];
  return rows.map(decode);
}

/** Every Square refund id this system issued, for the refund watchdog. */
export async function recordedDealRefundIds(withinDays = 60): Promise<string[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT square_refund_id FROM deal_refunds
    WHERE square_refund_id IS NOT NULL
      AND created_at > NOW() - (${withinDays} * INTERVAL '1 day')
  `) as Record<string, unknown>[];
  return rows.map((r) => String(r.square_refund_id));
}

/** Test seam. */
export function _resetDealRefundSchema(): void {
  schemaReady = null;
}
