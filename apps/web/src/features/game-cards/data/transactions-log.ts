/**
 * Durable ledger for Intercard game-card transactions (reload now, new-card
 * later). One row per purchase attempt, keyed by `txn_id`. Serves three jobs:
 *
 *  1. Audit — what was bought, what Square did, what Intercard did.
 *  2. Persist-first anchor — the row is written BEFORE the Square charge, so a
 *     captured payment always has a durable record (hard rule: persist guest
 *     input independent of the external API).
 *  3. Recover-forward registry — a `load_state='pending'` row (charged but not
 *     yet confirmed loaded) is what the reconcile cron drives to completion,
 *     replaying the stable `tpi_transaction_id` (Intercard dedups).
 *
 * Lazy CREATE TABLE IF NOT EXISTS (no migrations framework). `startTxn` THROWS
 * if the DB is unconfigured — we must not move money without an audit row.
 * Updates swallow (money already moved; a log error must not surface).
 */
import { sql, isDbConfigured } from "@ft/db";
import type { LoadState, TxnKind, TxnState } from "../types";

export interface TxnStart {
  txnId: string;
  /** Shared across all cards paid for in one transaction (one Square order). */
  groupId: string;
  kind: TxnKind;
  locationCode: number;
  accountNumber: string;
  packageId: string;
  tokens: number;
  bonusTokens: number;
  amountCents: number;
  tpiTransactionId: string;
  contact?: unknown;
}

export interface TxnRow {
  id: number;
  txnId: string;
  groupId: string | null;
  kind: TxnKind;
  locationCode: number;
  accountNumber: string;
  packageId: string;
  tokens: number;
  bonusTokens: number;
  amountCents: number;
  tpiTransactionId: string;
  squareOrderId: string | null;
  squarePaymentIds: unknown;
  state: TxnState;
  loadState: LoadState;
  attempt: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS intercard_transactions (
      id BIGSERIAL PRIMARY KEY,
      txn_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'reload',
      location_code INTEGER NOT NULL,
      account_number TEXT NOT NULL,
      package_id TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      bonus_tokens INTEGER NOT NULL DEFAULT 0,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      tpi_transaction_id TEXT NOT NULL,
      square_order_id TEXT,
      square_payment_ids JSONB,
      state TEXT NOT NULL DEFAULT 'started',
      load_state TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 0,
      contact JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  // Additive migration — table may already exist from round 1 (multi-card round 2).
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS group_id TEXT`;
  await q`CREATE INDEX IF NOT EXISTS ict_acct ON intercard_transactions (account_number)`;
  await q`CREATE INDEX IF NOT EXISTS ict_group ON intercard_transactions (group_id)`;
  // Partial index the reconcile cron scans: charged-but-not-loaded rows.
  await q`
    CREATE INDEX IF NOT EXISTS ict_pending
    ON intercard_transactions (created_at)
    WHERE load_state = 'pending' AND state = 'charged'
  `;
  schemaReady = true;
}

/** Insert the row before charging. THROWS if the DB is unconfigured. */
export async function startTxn(ev: TxnStart): Promise<void> {
  if (!isDbConfigured()) {
    throw new Error("game-cards: DATABASE_URL not configured");
  }
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO intercard_transactions (
      txn_id, group_id, kind, location_code, account_number, package_id,
      tokens, bonus_tokens, amount_cents, tpi_transaction_id, contact,
      state, load_state
    ) VALUES (
      ${ev.txnId}, ${ev.groupId}, ${ev.kind}, ${ev.locationCode}, ${ev.accountNumber}, ${ev.packageId},
      ${ev.tokens}, ${ev.bonusTokens}, ${ev.amountCents}, ${ev.tpiTransactionId},
      ${ev.contact ? JSON.stringify(ev.contact) : null}, 'started', 'pending'
    )
    ON CONFLICT (txn_id) DO NOTHING
  `;
}

/** Record the Square charge succeeded; load is now pending. */
export async function markCharged(
  txnId: string,
  squareOrderId: string | null,
  squarePaymentIds: unknown,
): Promise<void> {
  await safeUpdate(async (q) => {
    await q`
      UPDATE intercard_transactions
      SET state = 'charged', square_order_id = ${squareOrderId},
          square_payment_ids = ${squarePaymentIds ? JSON.stringify(squarePaymentIds) : null}
      WHERE txn_id = ${txnId}
    `;
  });
}

export async function markChargeFailed(txnId: string, error: string): Promise<void> {
  await safeUpdate(async (q) => {
    await q`
      UPDATE intercard_transactions
      SET state = 'charge_failed', error = ${error}, completed_at = NOW()
      WHERE txn_id = ${txnId}
    `;
  });
}

/** Flip load state after the Intercard call (loaded → completed). */
export async function markLoadState(
  txnId: string,
  loadState: LoadState,
  error?: string,
): Promise<void> {
  await safeUpdate(async (q) => {
    const state = loadState === "loaded" ? "completed" : "charged";
    const completed = loadState === "loaded";
    await q`
      UPDATE intercard_transactions
      SET load_state = ${loadState},
          state = ${state},
          error = ${error ?? null},
          completed_at = ${completed ? new Date().toISOString() : null}
      WHERE txn_id = ${txnId}
    `;
  });
}

/** Bump the reconcile attempt counter; returns the new count. */
export async function incrementAttempt(txnId: string): Promise<number> {
  if (!isDbConfigured()) return 0;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      UPDATE intercard_transactions SET attempt = attempt + 1
      WHERE txn_id = ${txnId} RETURNING attempt
    `;
    return (rows[0]?.attempt as number) ?? 0;
  } catch {
    return 0;
  }
}

/** Charged-but-unloaded rows for the reconcile cron, oldest first. */
export async function listPendingLoads(limit = 50): Promise<TxnRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM intercard_transactions
      WHERE load_state = 'pending' AND state = 'charged'
      ORDER BY created_at ASC LIMIT ${limit}
    `;
    return rows.map(rowToTxn);
  } catch {
    return [];
  }
}

export async function getTxn(txnId: string): Promise<TxnRow | null> {
  if (!isDbConfigured()) return null;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`SELECT * FROM intercard_transactions WHERE txn_id = ${txnId} LIMIT 1`;
    return rows.length ? rowToTxn(rows[0]) : null;
  } catch {
    return null;
  }
}

async function safeUpdate(fn: (q: ReturnType<typeof sql>) => Promise<void>): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    await fn(sql());
  } catch (err) {
    console.error("[game-cards-log] update failed:", err instanceof Error ? err.message : err);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToTxn(r: any): TxnRow {
  return {
    id: r.id,
    txnId: r.txn_id,
    groupId: r.group_id ?? null,
    kind: r.kind,
    locationCode: r.location_code,
    accountNumber: r.account_number,
    packageId: r.package_id,
    tokens: r.tokens,
    bonusTokens: r.bonus_tokens,
    amountCents: r.amount_cents,
    tpiTransactionId: r.tpi_transaction_id,
    squareOrderId: r.square_order_id,
    squarePaymentIds: r.square_payment_ids,
    state: r.state,
    loadState: r.load_state,
    attempt: r.attempt,
    error: r.error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
