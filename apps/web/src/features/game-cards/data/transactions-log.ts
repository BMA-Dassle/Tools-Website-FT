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
 *
 * BRIDGE QUEUE (`queue_state`, web reloads via the on-prem EIS server):
 *
 *   NULL      row belongs to the cloud-SOAP path (dedups on tpi_transaction_id)
 *   queued    charged, waiting for a center bridge to claim (markChargedQueued)
 *   claimed   ONE bridge owns it (FOR UPDATE SKIP LOCKED) and may EIS-credit
 *   done      credit confirmed (bridge ack `ok`, or verify resolved it)
 *   soap_fallback  EIS definitively did NOT credit (declined/no_attempt ack,
 *             or nothing claimed within 60s) → row rejoins the SOAP replay set
 *   verify    EIS outcome UNKNOWN (request written, no reply / lease expired) —
 *             resolved by cloud-history match or flagged manual. NEVER replayed
 *             on either path: the EIS credit has NO idempotency id, so a blind
 *             retry after an unknown outcome is a double credit.
 *   manual    verify never matched — staff must check Intercard reports
 *
 * SOAP-eligible: load_state='pending' AND state='charged' AND
 *   (queue_state IS NULL OR queue_state='soap_fallback').
 * EIS-eligible: queue_state='claimed', only by the claiming bridge.
 * The sets are disjoint; every transition is ONE guarded UPDATE (the Neon HTTP
 * driver runs each statement as its own atomic transaction).
 */
import { sql, isDbConfigured } from "@ft/db";
import type { LoadState, QueueState, TxnKind, TxnState } from "../types";

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
  queueState: QueueState | null;
  queuedAt: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  ackedAt: string | null;
  eisCode: string | null;
  eisDescription: string | null;
  loadedVia: string | null;
  /** BMI comp voucher that authorised this row (kind='voucher' only). */
  voucherCode: string | null;
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
  // Bridge-queue columns (round 3: web reloads via the on-prem EIS bridge).
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS queue_state TEXT`;
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ`;
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS claimed_by TEXT`;
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`;
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ`;
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS eis_code TEXT`;
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS eis_description TEXT`;
  // Which door delivered the credit: 'bridge' (web queue, on-prem EIS),
  // 'kiosk_bridge' (kiosk fast path), 'soap' (cloud), 'verify' (history match).
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS loaded_via TEXT`;
  // Round 4: BMI comp vouchers dispensed as cards (kind='voucher', amount 0).
  await q`ALTER TABLE intercard_transactions ADD COLUMN IF NOT EXISTS voucher_code TEXT`;
  await q`CREATE INDEX IF NOT EXISTS ict_acct ON intercard_transactions (account_number)`;
  await q`CREATE INDEX IF NOT EXISTS ict_group ON intercard_transactions (group_id)`;
  // Partial index the reconcile cron scans: charged-but-not-loaded rows.
  await q`
    CREATE INDEX IF NOT EXISTS ict_pending
    ON intercard_transactions (created_at)
    WHERE load_state = 'pending' AND state = 'charged'
  `;
  // Partial index the bridges' claim query scans: queued jobs per center.
  await q`
    CREATE INDEX IF NOT EXISTS ict_queued
    ON intercard_transactions (location_code, queued_at)
    WHERE queue_state = 'queued'
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

/**
 * Insert a COMPED row (BMI voucher → dispensed card) already cleared to load.
 *
 * There is no charge step to wait for, so the row lands `state='charged'` in
 * ONE statement. `state` here means "consideration settled — cleared to load",
 * which for a comp is true the moment the voucher claim is held; `amount_cents`
 * stays 0 and `voucher_code` records what authorised it. Landing in the normal
 * charged+pending shape is deliberate: voucher rows then sit inside the exact
 * recover-forward set the reconcile cron already drives, so a credit that
 * doesn't confirm is replayed on the stable tpi_transaction_id instead of
 * needing a second recovery path.
 *
 * THROWS if the DB is unconfigured (same rule as startTxn — never move value
 * without an audit row). The caller MUST already hold the voucher claim: this
 * function does not authorise anything, and `loadCard` re-checks the claim
 * before it credits.
 */
export async function startCompedTxn(
  ev: Omit<TxnStart, "amountCents"> & { voucherCode: string },
): Promise<void> {
  if (!isDbConfigured()) {
    throw new Error("game-cards: DATABASE_URL not configured");
  }
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO intercard_transactions (
      txn_id, group_id, kind, location_code, account_number, package_id,
      tokens, bonus_tokens, amount_cents, tpi_transaction_id, contact,
      voucher_code, state, load_state
    ) VALUES (
      ${ev.txnId}, ${ev.groupId}, ${ev.kind}, ${ev.locationCode}, ${ev.accountNumber}, ${ev.packageId},
      ${ev.tokens}, ${ev.bonusTokens}, 0, ${ev.tpiTransactionId},
      ${ev.contact ? JSON.stringify(ev.contact) : null}, ${ev.voucherCode}, 'charged', 'pending'
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

export interface GroupLoadStatus {
  txnId: string;
  accountNumber: string;
  loadState: LoadState;
  queueState: QueueState | null;
  loadedVia: LoadedVia | null;
  tokens: number;
  bonusTokens: number;
}

/** One-statement view of a purchase group's progress — feeds the purchase
 *  wait loop AND the public load-status poll the success screen uses. */
export async function getGroupQueueStates(groupId: string): Promise<GroupLoadStatus[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT txn_id, account_number, load_state, queue_state, loaded_via, tokens, bonus_tokens
      FROM intercard_transactions
      WHERE group_id = ${groupId}
    `;
    return rows.map((r) => ({
      txnId: r.txn_id as string,
      accountNumber: r.account_number as string,
      loadState: r.load_state as LoadState,
      queueState: (r.queue_state ?? null) as QueueState | null,
      loadedVia: (r.loaded_via ?? null) as LoadedVia | null,
      tokens: r.tokens as number,
      bonusTokens: r.bonus_tokens as number,
    }));
  } catch {
    return [];
  }
}

/** Queued rows no bridge claimed within 60s (bridge down) → SOAP path. */
export async function sweepStaleQueued(): Promise<string[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      UPDATE intercard_transactions
      SET queue_state = 'soap_fallback'
      WHERE queue_state = 'queued' AND queued_at < NOW() - INTERVAL '60 seconds'
      RETURNING txn_id
    `;
    return rows.map((r) => r.txn_id as string);
  } catch (err) {
    console.error(
      "[game-cards-log] queued sweep failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Claimed rows whose bridge never acked within the lease (died mid-flight —
 * the EIS credit may or may not have landed) → 'verify'. Never back to the
 * queue and never to SOAP: unknown outcome must not be blindly retried.
 */
export async function sweepStaleClaimed(): Promise<string[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      UPDATE intercard_transactions
      SET queue_state = 'verify'
      WHERE queue_state = 'claimed' AND claimed_at < NOW() - INTERVAL '3 minutes'
        AND load_state = 'pending'
      RETURNING txn_id
    `;
    return rows.map((r) => r.txn_id as string);
  } catch (err) {
    console.error(
      "[game-cards-log] claimed sweep failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Unknown-outcome rows awaiting history verification, oldest first. */
export async function listVerifyRows(limit = 50): Promise<TxnRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM intercard_transactions
      WHERE queue_state = 'verify' AND load_state = 'pending'
      ORDER BY queued_at ASC LIMIT ${limit}
    `;
    return rows.map(rowToTxn);
  } catch {
    return [];
  }
}

/** Cloud history showed the EIS credit landed → resolve the verify row loaded. */
export async function markVerifiedLoaded(txnId: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      UPDATE intercard_transactions
      SET load_state = 'loaded', state = 'completed', completed_at = NOW(), error = NULL,
          queue_state = 'done', loaded_via = 'verify'
      WHERE txn_id = ${txnId} AND queue_state = 'verify' AND load_state = 'pending'
      RETURNING txn_id
    `;
    return rows.length > 0;
  } catch (err) {
    console.error(
      "[game-cards-log] verify-loaded failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Verify row never matched history — flag for staff (check Intercard reports). */
export async function markVerifyManual(txnId: string, error: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      UPDATE intercard_transactions
      SET load_state = 'load_failed', error = ${error}, queue_state = 'manual'
      WHERE txn_id = ${txnId} AND queue_state = 'verify' AND load_state = 'pending'
      RETURNING txn_id
    `;
    return rows.length > 0;
  } catch (err) {
    console.error(
      "[game-cards-log] verify-manual failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
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

export type LoadedVia = "bridge" | "kiosk_bridge" | "soap" | "verify";

/** Flip load state after the Intercard call (loaded → completed). `via` stamps
 *  which door delivered a confirmed load (diagnostics; never guest-facing). */
export async function markLoadState(
  txnId: string,
  loadState: LoadState,
  error?: string,
  via?: LoadedVia,
): Promise<void> {
  await safeUpdate(async (q) => {
    const state = loadState === "loaded" ? "completed" : "charged";
    const completed = loadState === "loaded";
    const loadedVia = loadState === "loaded" ? (via ?? null) : null;
    if (loadedVia) {
      await q`
        UPDATE intercard_transactions
        SET load_state = ${loadState},
            state = ${state},
            error = ${error ?? null},
            completed_at = ${completed ? new Date().toISOString() : null},
            loaded_via = ${loadedVia}
        WHERE txn_id = ${txnId}
      `;
    } else {
      await q`
        UPDATE intercard_transactions
        SET load_state = ${loadState},
            state = ${state},
            error = ${error ?? null},
            completed_at = ${completed ? new Date().toISOString() : null}
        WHERE txn_id = ${txnId}
      `;
    }
  });
}

/**
 * Attach the real account number to a row after it's read off the dispensed
 * blank (new-card flow — the row was created with an empty account at charge
 * time). Follows the file's "updates swallow" rule.
 */
export async function setTxnAccount(txnId: string, accountNumber: string): Promise<void> {
  await safeUpdate(async (q) => {
    await q`
      UPDATE intercard_transactions
      SET account_number = ${accountNumber}
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

/**
 * Charged-but-unloaded rows the SOAP replay may touch, oldest first. The
 * queue_state exclusion is load-bearing: rows a bridge may EIS-credit
 * ('queued'/'claimed'/'verify'/'manual') must NEVER be SOAP-replayed — the
 * two credit paths share no dedup, so replaying one of those rows is a
 * double credit. Only never-queued (NULL) and 'soap_fallback' (EIS
 * definitively did not credit) rows are eligible.
 *
 * KIOSK new-card rows (`new_card` / comped `voucher`) get a 15-minute grace:
 * the kiosk that charged them is about to credit them ITSELF through the
 * on-prem bridge (dispense → load, or — on a swipe kiosk — a load onto the
 * account persisted at prepare/claim). Until 2026-08-28 those rows carried an
 * empty account until the kiosk attached one at load, so the cron could never
 * reach a real card first; a swipe kiosk persists the account up front, and
 * without the grace a cron tick landing between the charge and the kiosk's
 * bridge credit would SOAP-credit the same card (double credit). The cron is
 * the safety net for a kiosk that died, not a competitor for a live one.
 */
export async function listPendingLoads(limit = 50): Promise<TxnRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM intercard_transactions
      WHERE load_state = 'pending' AND state = 'charged'
        AND (queue_state IS NULL OR queue_state = 'soap_fallback')
        AND (kind NOT IN ('new_card', 'voucher') OR created_at < NOW() - INTERVAL '15 minutes')
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
    queueState: r.queue_state ?? null,
    queuedAt: r.queued_at ?? null,
    claimedBy: r.claimed_by ?? null,
    claimedAt: r.claimed_at ?? null,
    ackedAt: r.acked_at ?? null,
    eisCode: r.eis_code ?? null,
    eisDescription: r.eis_description ?? null,
    loadedVia: r.loaded_via ?? null,
    voucherCode: r.voucher_code ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
