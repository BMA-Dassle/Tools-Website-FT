import { sql, isDbConfigured } from "@/lib/db";

/**
 * BMI project-payment failure tracker — durable retry queue for failed
 * `POST /api/{client}/projectPayment` calls.
 *
 * ── Why this exists ────────────────────────────────────────────────
 * `confirmAndRecordBmiPayment` is deliberately non-fatal: the guest's card has
 * already been charged by the time we call BMI, so a BMI hiccup must never
 * surface as a payment error (the guest would pay twice). Before this table the
 * cost of that decision was that a failure was *only* a `console.error` — no
 * retry, no alert, no record. The money was collected, BMI never heard about it,
 * and nobody knew until someone eyeballed a balance.
 *
 * That is exactly what the 2026-08-03 outage did: Pandora's Office auth endpoint
 * returned ASP.NET 500s for ~6 hours and two events' payments ($2,113.95) were
 * silently dropped. They had to be found by diffing our `collected_cents`
 * against BMI's live payment ledger after the fact. This queue makes the next
 * one self-heal.
 *
 * ── Storage ────────────────────────────────────────────────────────
 * Neon Postgres, auto-bootstrapped on first write — no migration needed. Same
 * shape and conventions as `bmi_deposit_failures` (see `lib/bmi-deposit-retry.ts`).
 *
 * ── Idempotency ────────────────────────────────────────────────────
 * `(source, source_ref, project_id, amount_cents)` is UNIQUE, so re-enqueueing
 * the same failure is a no-op via UPSERT.
 *
 * ── Why the sweep re-reads BMI instead of blindly retrying ─────────
 * A failed call is NOT proof the write didn't land — a timeout or a dropped
 * response can follow a payment BMI actually recorded. A blind retry would
 * double-post real money into the center's books. So the sweep recomputes
 * `gap = our collected_cents - BMI's non-voided payment sum` and records
 * `min(gap, BMI balance, this row's amount)`, skipping when that is <= 0. Capping
 * by the row's own amount is what lets two queued failures on the same event
 * (deposit + balance) settle correctly and independently.
 */

export type ProjectPaymentFailureSource =
  | "gf-deposit" // /api/group-function/deposit — deposit captured, BMI post failed
  | "gf-balance-pay" // /api/group-function/balance-pay — guest-paid balance
  | "gf-balance-charge-cron" // /api/cron/group-balance-charge — auto-charged balance
  | "gf-resign-settle" // /api/group-function/resign-settle — reprice delta
  | "manual"; // staff-entered backfill row

export interface ProjectPaymentFailureRow {
  id: number;
  source: ProjectPaymentFailureSource | string;
  sourceRef: string;
  quoteId: number | null;
  centerCode: string;
  projectId: string;
  amountCents: number;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedReference: string | null;
  resolution: string | null;
  notes: string | null;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS bmi_project_payment_failures (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      quote_id BIGINT,
      center_code TEXT NOT NULL,
      project_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_reference TEXT,
      resolution TEXT,
      notes TEXT
    )
  `;
  await q`
    CREATE UNIQUE INDEX IF NOT EXISTS bmi_project_payment_failures_idem
    ON bmi_project_payment_failures (source, source_ref, project_id, amount_cents)
  `;
  await q`
    CREATE INDEX IF NOT EXISTS bmi_project_payment_failures_unresolved
    ON bmi_project_payment_failures (last_attempt_at NULLS FIRST, created_at)
    WHERE resolved_at IS NULL
  `;
  await q`
    CREATE INDEX IF NOT EXISTS bmi_project_payment_failures_project
    ON bmi_project_payment_failures (project_id, created_at DESC)
  `;
  schemaReady = true;
}

export interface EnqueueProjectPaymentParams {
  source: ProjectPaymentFailureSource | string;
  /** Cross-reference to the originating record — the Square payment id where we
   *  have one, else `quote-{id}-{deposit|balance}`. Part of the idempotency key,
   *  so it must be stable across retries of the SAME logical payment and
   *  distinct across different ones. */
  sourceRef: string;
  quoteId?: number | null;
  centerCode: string;
  projectId: string;
  amountCents: number;
  initialError?: string;
  notes?: string;
}

/**
 * Record a failed projectPayment post. Called from the payment step's catch —
 * failures here are logged and swallowed, because this must never break the
 * caller's response after the card has been charged.
 */
export async function enqueueProjectPaymentFailure(
  params: EnqueueProjectPaymentParams,
): Promise<void> {
  if (!isDbConfigured()) {
    console.warn("[bmi-payment-retry] DATABASE_URL not set — skipping enqueue");
    return;
  }
  if (!params.amountCents || params.amountCents <= 0 || !Number.isInteger(params.amountCents)) {
    console.warn("[bmi-payment-retry] refusing to enqueue non-positive / non-integer amount");
    return;
  }
  if (!params.projectId) {
    console.warn("[bmi-payment-retry] refusing to enqueue without a projectId");
    return;
  }
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO bmi_project_payment_failures (
        source, source_ref, quote_id, center_code, project_id, amount_cents,
        attempts, last_attempt_at, last_error, notes
      ) VALUES (
        ${params.source}, ${params.sourceRef}, ${params.quoteId ?? null},
        ${params.centerCode}, ${String(params.projectId)}, ${params.amountCents},
        1, NOW(), ${params.initialError ?? null}, ${params.notes ?? null}
      )
      ON CONFLICT (source, source_ref, project_id, amount_cents)
      DO UPDATE SET
        last_attempt_at = NOW(),
        last_error = COALESCE(${params.initialError ?? null}, bmi_project_payment_failures.last_error)
      WHERE bmi_project_payment_failures.resolved_at IS NULL
    `;
    console.error(
      `[bmi-payment-retry] ENQUEUED unposted payment source=${params.source} ref=${params.sourceRef} ` +
        `project=${params.projectId} amount=${(params.amountCents / 100).toFixed(2)} — money collected, BMI not updated`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(`[bmi-payment-retry] enqueue failed: ${msg}`);
  }
}

/**
 * After this many attempts a row is PARKED: still unresolved and still reported,
 * but no longer retried. Matches `bmi-deposit-retry`'s ceiling and the reasoning
 * behind it — past this point it isn't a transient upstream blip, it needs a
 * human, and hammering the vendor forever helps nobody.
 */
export const MAX_RETRY_ATTEMPTS = 25;

/** Retryable rows for the sweep, oldest-attempt first, with escalating backoff. */
export async function listRetryable(limit: number = 50): Promise<ProjectPaymentFailureRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT id, source, source_ref, quote_id, center_code, project_id, amount_cents,
           attempts, last_attempt_at, last_error, created_at, resolved_at,
           resolved_reference, resolution, notes
    FROM bmi_project_payment_failures
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

/** Rows that gave up and are waiting on a human. */
export async function listParked(limit: number = 100): Promise<ProjectPaymentFailureRow[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT id, source, source_ref, quote_id, center_code, project_id, amount_cents,
           attempts, last_attempt_at, last_error, created_at, resolved_at,
           resolved_reference, resolution, notes
    FROM bmi_project_payment_failures
    WHERE resolved_at IS NULL AND attempts >= ${MAX_RETRY_ATTEMPTS}
    ORDER BY created_at
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
  return (rows as Array<Record<string, unknown>>).map(rowToObject);
}

export interface RecordAttemptParams {
  id: number;
  success: boolean;
  /** BMI's returned paymentReference on a successful post. */
  resolvedReference?: string;
  /** How it resolved: "recorded" (we posted it) or "already-square" (BMI already
   *  had the money — the original call had in fact landed). */
  resolution?: "recorded" | "already-square";
  error?: string;
}

export async function recordRetryAttempt(params: RecordAttemptParams): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  if (params.success) {
    await q`
      UPDATE bmi_project_payment_failures
      SET attempts = attempts + 1,
          last_attempt_at = NOW(),
          last_error = NULL,
          resolved_at = NOW(),
          resolved_reference = ${params.resolvedReference ?? null},
          resolution = ${params.resolution ?? "recorded"}
      WHERE id = ${params.id} AND resolved_at IS NULL
    `;
  } else {
    await q`
      UPDATE bmi_project_payment_failures
      SET attempts = attempts + 1,
          last_attempt_at = NOW(),
          last_error = ${params.error ?? "unknown"}
      WHERE id = ${params.id} AND resolved_at IS NULL
    `;
  }
}

/**
 * How much of a queued row the sweep may actually post to BMI.
 *
 * This is the guard that stops the retry queue from double-charging a center's
 * books. A failed POST is not proof the write didn't land — a timeout can follow
 * a payment BMI recorded fine. So we never post the queued amount on faith; we
 * post the smallest of three independently-derived ceilings:
 *
 *   1. `collectedCents - recordedCents` — the real gap between what we took from
 *      the card and what BMI's ledger shows. Zero or negative means BMI already
 *      has the money and there is nothing to do.
 *   2. `balanceCents` — BMI's own view of what it is still owed. Never push a
 *      project past settled.
 *   3. `amountCents` — this row's own payment. Keeps two queued failures on one
 *      event (deposit + balance) from cannibalising each other: the first posts
 *      its deposit, the second then sees a smaller gap and posts its balance.
 *
 * `collectedCents === null` means we had no quote to read (a `manual` row), in
 * which case the row's own amount is the only figure we have — still capped by
 * BMI's balance.
 */
export function computePostableCents(input: {
  collectedCents: number | null;
  recordedCents: number;
  balanceCents: number;
  amountCents: number;
}): number {
  const gapCents =
    input.collectedCents === null ? input.amountCents : input.collectedCents - input.recordedCents;
  return Math.max(0, Math.min(gapCents, input.balanceCents, input.amountCents));
}

export interface ProjectPaymentFailureSummary {
  unresolvedCount: number;
  unresolvedAmountCents: number;
  oldestUnresolvedAt: string | null;
  parkedCount: number;
}

/** Counts for the admin dashboard / alerting. */
export async function summarizeProjectPaymentFailures(): Promise<ProjectPaymentFailureSummary> {
  const empty: ProjectPaymentFailureSummary = {
    unresolvedCount: 0,
    unresolvedAmountCents: 0,
    oldestUnresolvedAt: null,
    parkedCount: 0,
  };
  if (!isDbConfigured()) return empty;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(amount_cents), 0)::int AS amount_sum,
           MIN(created_at) AS oldest,
           COUNT(*) FILTER (WHERE attempts >= ${MAX_RETRY_ATTEMPTS})::int AS parked
    FROM bmi_project_payment_failures
    WHERE resolved_at IS NULL
  `) as Array<{ count: number; amount_sum: number; oldest: string | null; parked: number }>;
  const t = rows[0] ?? { count: 0, amount_sum: 0, oldest: null, parked: 0 };
  return {
    unresolvedCount: Number(t.count) || 0,
    unresolvedAmountCents: Number(t.amount_sum) || 0,
    oldestUnresolvedAt: t.oldest,
    parkedCount: Number(t.parked) || 0,
  };
}

function rowToObject(r: Record<string, unknown>): ProjectPaymentFailureRow {
  return {
    id: Number(r.id),
    source: String(r.source),
    sourceRef: String(r.source_ref),
    quoteId: r.quote_id === null || r.quote_id === undefined ? null : Number(r.quote_id),
    centerCode: String(r.center_code),
    projectId: String(r.project_id),
    amountCents: Number(r.amount_cents),
    attempts: Number(r.attempts) || 0,
    lastAttemptAt: r.last_attempt_at ? String(r.last_attempt_at) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
    resolvedReference: r.resolved_reference ? String(r.resolved_reference) : null,
    resolution: r.resolution ? String(r.resolution) : null,
    notes: r.notes ? String(r.notes) : null,
  };
}
