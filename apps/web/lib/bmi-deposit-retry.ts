import { sql, isDbConfigured } from "@/lib/db";

/**
 * BMI deposit failure tracker — durable retry queue for failed
 * `POST /bmi/deposit` calls.
 *
 * Two flows depend on this:
 *
 *  1. **Race pack sales (positive amounts).** `app/api/square/pay`
 *     charges the customer via Square then calls Pandora's
 *     `addDeposit()` to load race credits. When that fails, the
 *     customer is charged but holds no credits — they need our
 *     team to reconcile manually today. Pre-fix, the only signal
 *     was a `sales_log.deposit_credit_pending=TRUE` row that nobody
 *     polled. This table makes the retry automatic.
 *
 *  2. **POV voucher claims (negative amounts).** When a participant
 *     claims POV codes against their ViewPoint Credit balance, we
 *     issue codes first then deduct. If the deduct call fails we
 *     owe BMA the decrement. Same retry pipeline.
 *
 * ── Storage ────────────────────────────────────────────────────────
 * Neon Postgres (durable, survives Redis evictions, queryable from
 * the admin board). Auto-bootstrapped on first write — no migration
 * needed.
 *
 * ── Idempotency ────────────────────────────────────────────────────
 * `(source, source_ref, person_id, deposit_kind_id, amount)` is
 * UNIQUE. Re-enqueueing the same failure is a no-op via UPSERT.
 *
 * ── Retry strategy ─────────────────────────────────────────────────
 * Sweep cron (`/api/cron/deposit-retry-sweep`) runs every 5 min,
 * picks unresolved rows oldest-attempt first, calls
 * `/api/pandora/deposit` for each. On success: marks resolved.
 * On failure: bumps `attempts`, records `last_error`, sets
 * `last_attempt_at`. Retries back off as `attempts` climbs and STOP at
 * MAX_RETRY_ATTEMPTS — see the note there; the original "no backoff,
 * retry forever" assumption held only for transient BMA outages, and
 * cost ~82,000 upstream calls on 9 rows that could never succeed.
 */

export type DepositFailureSource =
  | "race-pack-square" // /api/square/pay — addDeposit failed after Square charge
  | "race-credit-redeem" // v2 race checkout — credit redemption deduct failed
  | "pov-claim" // /api/pov-codes?action=claim-from-credit — deduct failed
  | "headsock-checkin" // /api/admin/checkin — headsock deposit deduct failed
  | "addon-headsock" // booking add-on grant (addon-grant.server) — +credit failed after charge
  | "manual" // staff-entered backfill row
  | "sales-log-backfill"; // one-time import from old sales_log.deposit_credit_pending rows

export interface DepositFailureRow {
  id: number;
  source: DepositFailureSource | string;
  sourceRef: string;
  locationId: string;
  personId: string;
  depositKindId: string;
  amount: number;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedDepositId: string | null;
  notes: string | null;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS bmi_deposit_failures (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      location_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      deposit_kind_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_deposit_id TEXT,
      notes TEXT
    )
  `;
  // Idempotency key. Re-enqueueing the same failure is a no-op via
  // UPSERT. Includes amount so a sale + a refund (opposite signs)
  // are tracked separately even if everything else matches.
  await q`
    CREATE UNIQUE INDEX IF NOT EXISTS bmi_deposit_failures_idem
    ON bmi_deposit_failures (source, source_ref, person_id, deposit_kind_id, amount)
  `;
  // Sweep-cron read pattern: unresolved rows ordered by oldest
  // attempt. Partial index keeps it tiny since most rows resolve
  // within minutes.
  await q`
    CREATE INDEX IF NOT EXISTS bmi_deposit_failures_unresolved
    ON bmi_deposit_failures (last_attempt_at NULLS FIRST, created_at)
    WHERE resolved_at IS NULL
  `;
  await q`
    CREATE INDEX IF NOT EXISTS bmi_deposit_failures_person
    ON bmi_deposit_failures (person_id, created_at DESC)
  `;
  schemaReady = true;
}

export interface EnqueueParams {
  source: DepositFailureSource | string;
  /** Cross-reference to the originating record. For race packs this is
   *  the Square paymentId or pack ref; for POV claims, the personId
   *  (or `{personId}-{sessionId}`); for manual, an admin-entered note. */
  sourceRef: string;
  locationId: string;
  personId: string | number;
  depositKindId: string | number;
  /** Signed integer. Positive = add (race pack), negative = remove
   *  (POV claim). Zero is invalid — Pandora rejects it. */
  amount: number;
  /** Optional initial-failure error so the first row already shows
   *  what went wrong without waiting for a retry attempt. */
  initialError?: string;
  /** Optional human notes (admin-entered backfills, etc.). */
  notes?: string;
}

/**
 * Insert a failure row, or update the existing one if the same
 * (source, source_ref, person, kind, amount) already exists. Use this
 * the moment a deposit call fails — caller-side, before returning to
 * the customer.
 *
 * Failures are logged + swallowed: enqueue must never break the
 * caller's response flow. Worst case the row doesn't get tracked and
 * a human notices via the admin board.
 */
export async function enqueueDepositFailure(params: EnqueueParams): Promise<void> {
  if (!isDbConfigured()) {
    console.warn("[bmi-deposit-retry] DATABASE_URL not set — skipping enqueue");
    return;
  }
  if (!params.amount || params.amount === 0 || !Number.isInteger(params.amount)) {
    console.warn("[bmi-deposit-retry] refusing to enqueue zero / non-integer amount");
    return;
  }
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO bmi_deposit_failures (
        source, source_ref, location_id, person_id, deposit_kind_id, amount,
        attempts, last_attempt_at, last_error, notes
      ) VALUES (
        ${params.source}, ${params.sourceRef}, ${params.locationId},
        ${String(params.personId)}, ${String(params.depositKindId)}, ${params.amount},
        1, NOW(), ${params.initialError ?? null}, ${params.notes ?? null}
      )
      ON CONFLICT (source, source_ref, person_id, deposit_kind_id, amount)
      DO UPDATE SET
        last_attempt_at = NOW(),
        last_error = COALESCE(${params.initialError ?? null}, bmi_deposit_failures.last_error),
        notes = COALESCE(${params.notes ?? null}, bmi_deposit_failures.notes)
      WHERE bmi_deposit_failures.resolved_at IS NULL
    `;
    console.log(
      `[bmi-deposit-retry] enqueued source=${params.source} ref=${params.sourceRef} person=${params.personId} kind=${params.depositKindId} amount=${params.amount}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(`[bmi-deposit-retry] enqueue failed: ${msg}`);
  }
}

/**
 * After this many failed attempts a row is PARKED: still unresolved (the admin
 * list and the money owed are untouched) but no longer retried, because at that
 * point it is not a transient upstream blip — it needs a human.
 *
 * Set from real data on 2026-07-30: the sweep had 9 rows at 4,122–19,114 attempts
 * each (~82,000 upstream calls, the oldest retrying every 5 minutes since May 24)
 * while 77 other rows resolved within a handful of tries. Every one of the 9
 * pointed at a Pandora person that returns 404 "No person found with that ID", so
 * the deposit could never succeed — and /bmi/deposit reports it as a generic
 * 500, which is why the sweep could not tell "later" from "never".
 */
export const MAX_RETRY_ATTEMPTS = 25;

/** Fetch the next batch of RETRYABLE failures for the sweep cron.
 *
 *  Oldest-attempt-first so a genuinely stuck row isn't starved, but with two
 *  gates the original query lacked:
 *    - parked rows (attempts >= MAX_RETRY_ATTEMPTS) are excluded entirely
 *    - escalating backoff, so even a young row isn't hammered every 5 minutes
 *
 *  Deliberately NOT filtered out of the admin views: the guest is still owed the
 *  credit, so the row must stay visible and unresolved. */
export async function listRetryable(limit: number = 50): Promise<DepositFailureRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT id, source, source_ref, location_id, person_id, deposit_kind_id, amount,
           attempts, last_attempt_at, last_error, created_at, resolved_at,
           resolved_deposit_id, notes
    FROM bmi_deposit_failures
    WHERE resolved_at IS NULL
      AND attempts < ${MAX_RETRY_ATTEMPTS}
      AND (
        last_attempt_at IS NULL
        OR last_attempt_at < now() - (interval '5 minutes' * LEAST(attempts, 12))
      )
    ORDER BY last_attempt_at NULLS FIRST, created_at
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
  return (rows as Array<Record<string, unknown>>).map(rowToObject);
}

/** Rows that have given up retrying and are waiting on a human — what the sweep
 *  should report and an alert/board should show. */
export async function listParked(limit: number = 100): Promise<DepositFailureRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT id, source, source_ref, location_id, person_id, deposit_kind_id, amount,
           attempts, last_attempt_at, last_error, created_at, resolved_at,
           resolved_deposit_id, notes
    FROM bmi_deposit_failures
    WHERE resolved_at IS NULL AND attempts >= ${MAX_RETRY_ATTEMPTS}
    ORDER BY created_at
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
  return (rows as Array<Record<string, unknown>>).map(rowToObject);
}

export interface RecordRetryParams {
  id: number;
  /** When the retry succeeded — populates resolved_at + resolved_deposit_id. */
  success: boolean;
  /** Pandora's returned depositID on success. */
  resolvedDepositId?: string;
  /** Error message on failure. */
  error?: string;
}

export async function recordRetryAttempt(params: RecordRetryParams): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  if (params.success) {
    await q`
      UPDATE bmi_deposit_failures
      SET attempts = attempts + 1,
          last_attempt_at = NOW(),
          last_error = NULL,
          resolved_at = NOW(),
          resolved_deposit_id = ${params.resolvedDepositId ?? null}
      WHERE id = ${params.id} AND resolved_at IS NULL
    `;
  } else {
    await q`
      UPDATE bmi_deposit_failures
      SET attempts = attempts + 1,
          last_attempt_at = NOW(),
          last_error = ${params.error ?? "unknown"}
      WHERE id = ${params.id} AND resolved_at IS NULL
    `;
  }
}

/** Counts for the admin dashboard. */
export interface FailureSummary {
  unresolvedCount: number;
  unresolvedAmountSum: number; // signed sum, in deposit-kind units
  oldestUnresolvedAt: string | null;
  bySource: { source: string; count: number }[];
}

export async function summarizeFailures(): Promise<FailureSummary> {
  const empty: FailureSummary = {
    unresolvedCount: 0,
    unresolvedAmountSum: 0,
    oldestUnresolvedAt: null,
    bySource: [],
  };
  if (!isDbConfigured()) return empty;
  await ensureSchema();
  const q = sql();
  const totals = (await q`
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(amount), 0)::int AS amount_sum,
           MIN(created_at) AS oldest
    FROM bmi_deposit_failures
    WHERE resolved_at IS NULL
  `) as Array<{ count: number; amount_sum: number; oldest: string | null }>;
  const bySrc = (await q`
    SELECT source, COUNT(*)::int AS count
    FROM bmi_deposit_failures
    WHERE resolved_at IS NULL
    GROUP BY source
    ORDER BY count DESC
  `) as Array<{ source: string; count: number }>;
  const t = totals[0] ?? { count: 0, amount_sum: 0, oldest: null };
  return {
    unresolvedCount: Number(t.count) || 0,
    unresolvedAmountSum: Number(t.amount_sum) || 0,
    oldestUnresolvedAt: t.oldest,
    bySource: bySrc.map((r) => ({ source: r.source, count: Number(r.count) || 0 })),
  };
}

/** Look up failures for a specific person — admin "is this person
 *  missing credits?" lookup. */
export async function listForPerson(
  personId: string | number,
  limit: number = 50,
): Promise<DepositFailureRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT id, source, source_ref, location_id, person_id, deposit_kind_id, amount,
           attempts, last_attempt_at, last_error, created_at, resolved_at,
           resolved_deposit_id, notes
    FROM bmi_deposit_failures
    WHERE person_id = ${String(personId)}
    ORDER BY created_at DESC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
  return (rows as Array<Record<string, unknown>>).map(rowToObject);
}

/**
 * One-time backfill: copy `sales_log` rows where
 * `deposit_credit_pending = TRUE` into the failures table so the
 * sweep cron starts retrying them. Idempotent (UPSERT).
 *
 * Returns count of rows inserted/updated. Safe to run repeatedly —
 * resolved rows are excluded (`WHERE resolved_at IS NULL` on the
 * failures table) and the unique key prevents duplicates.
 */
export async function backfillFromSalesLog(): Promise<{ scanned: number; enqueued: number }> {
  if (!isDbConfigured()) return { scanned: 0, enqueued: 0 };
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT bill_id, deposit_person_id, deposit_kind_id, deposit_amount, location, brand, ts
    FROM sales_log
    WHERE deposit_credit_pending = TRUE
      AND deposit_person_id IS NOT NULL
      AND deposit_kind_id IS NOT NULL
      AND deposit_amount IS NOT NULL
  `) as Array<{
    bill_id: string | null;
    deposit_person_id: string;
    deposit_kind_id: string;
    deposit_amount: number;
    location: string | null;
    brand: string | null;
    ts: string;
  }>;
  let enqueued = 0;
  for (const r of rows) {
    // Map brand+location to a Pandora locationId. FastTrax is the
    // only brand that sells race packs today; HeadPinz centers
    // would be added if we ever sell HP packs through this flow.
    const locationId =
      r.brand === "fasttrax"
        ? "LAB52GY480CJF"
        : r.location === "naples"
          ? "PPTR5G2N0QXF7"
          : "TXBSQN0FEKQ11";
    await enqueueDepositFailure({
      source: "sales-log-backfill",
      sourceRef: r.bill_id ?? `salesrow-${r.ts}`,
      locationId,
      personId: r.deposit_person_id,
      depositKindId: r.deposit_kind_id,
      amount: r.deposit_amount,
      initialError: "backfilled from sales_log.deposit_credit_pending",
      notes: `Original sale ts=${r.ts}`,
    });
    enqueued++;
  }
  return { scanned: rows.length, enqueued };
}

function rowToObject(r: Record<string, unknown>): DepositFailureRow {
  return {
    id: Number(r.id),
    source: String(r.source),
    sourceRef: String(r.source_ref),
    locationId: String(r.location_id),
    personId: String(r.person_id),
    depositKindId: String(r.deposit_kind_id),
    amount: Number(r.amount),
    attempts: Number(r.attempts) || 0,
    lastAttemptAt: r.last_attempt_at ? String(r.last_attempt_at) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
    resolvedDepositId: r.resolved_deposit_id ? String(r.resolved_deposit_id) : null,
    notes: r.notes ? String(r.notes) : null,
  };
}
