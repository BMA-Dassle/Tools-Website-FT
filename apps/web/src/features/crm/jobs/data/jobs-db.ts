/**
 * `crm_jobs` — the CRM's own retry table (brief §3.9). NOT `bmi_sync_queue`:
 * that table is shared by preview and production, and a kind only `feat/crm`
 * knows would be picked up by the production cron and burn attempts.
 *
 * LIFECYCLE
 *   enqueue   INSERT … ON CONFLICT (idempotency_key) DO NOTHING — a second
 *             enqueue with the same key returns the existing row, `created:false`.
 *   lease     due rows (`pending` and past `next_attempt_at`, or `running` with
 *             an EXPIRED lease — a lambda that died mid-job) become `running`
 *             for `leaseSeconds`, `attempts + 1`, `FOR UPDATE SKIP LOCKED` so
 *             two drains never take the same row.
 *   complete  `done`, `result`, `resolved_at`.
 *   fail      `failed` with backoff `min(600, 30 × attempts)` s (the lease picks
 *             `failed` rows up again once `next_attempt_at` passes), or `parked`
 *             once `attempts >= max_attempts` (or the handler asked to park).
 *             `failed` is therefore "will retry"; `parked` is "gave up" and is
 *             what the director's "Needs attention" tile lists.
 *   release   back to `pending` WITHOUT counting the attempt — for rows a drain
 *             leased but could not reach before its deadline.
 *
 * The backoff lives in `planFailure()` (pure, tested) and is mirrored in the
 * SQL so the row is updated in one statement; `jobs-db.test.ts` pins both.
 *
 * `JobStore` is the seam: the runner takes one, `neonJobStore` is the real
 * one, `runner.test.ts` supplies an in-memory one.
 */

import { isDbConfigured, sql } from "@ft/db";
import { JOB_KINDS, type JobKind, type JobRow, type JobStatus } from "../../core/types";

let schemaReady: Promise<void> | null = null;

export function ensureJobsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_jobs (
        id BIGSERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','parked')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 20,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        leased_until TIMESTAMPTZ,
        last_error TEXT,
        result JSONB,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_jobs_due ON crm_jobs (next_attempt_at) WHERE status = 'pending'`;
    await q`CREATE INDEX IF NOT EXISTS crm_jobs_retry ON crm_jobs (next_attempt_at) WHERE status = 'failed'`;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

export const MAX_BACKOFF_SECONDS = 600;
export const BACKOFF_STEP_SECONDS = 30;

/** `min(600, 30 × attempts)` seconds; `attempts` is the count INCLUDING the one that just failed. */
export function backoffSeconds(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(MAX_BACKOFF_SECONDS, BACKOFF_STEP_SECONDS * n);
}

export interface FailurePlan {
  status: "failed" | "parked";
  /** Seconds until the next try; 0 when parked. */
  delaySeconds: number;
}

/** What happens to a job whose attempt just failed. */
export function planFailure(
  job: Pick<JobRow, "attempts" | "maxAttempts">,
  park = false,
): FailurePlan {
  if (park || job.attempts >= job.maxAttempts) return { status: "parked", delaySeconds: 0 };
  return { status: "failed", delaySeconds: backoffSeconds(job.attempts) };
}

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface JobRowRaw {
  id: string;
  kind: string;
  idempotency_key: string;
  payload: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  leased_until: string | null;
  last_error: string | null;
  result: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const STATUSES = new Set<JobStatus>(["pending", "running", "done", "failed", "parked"]);

export function mapJobRow(r: JobRowRaw): JobRow {
  return {
    id: String(r.id),
    kind: (isJobKind(r.kind) ? r.kind : "noop") as JobKind,
    idempotencyKey: r.idempotency_key,
    payload:
      r.payload && typeof r.payload === "object" && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : {},
    status: STATUSES.has(r.status as JobStatus) ? (r.status as JobStatus) : "pending",
    attempts: Number(r.attempts) || 0,
    maxAttempts: Number(r.max_attempts) || 20,
    nextAttemptAt: r.next_attempt_at,
    leasedUntil: r.leased_until ?? null,
    lastError: r.last_error ?? null,
    result: r.result ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at ?? null,
  };
}

const COLUMNS = `
  id::text AS id, kind, idempotency_key, payload, status, attempts, max_attempts,
  next_attempt_at::text AS next_attempt_at, leased_until::text AS leased_until, last_error, result,
  created_by, created_at::text AS created_at, updated_at::text AS updated_at, resolved_at::text AS resolved_at
`;

// ---------------------------------------------------------------------------
// The store seam
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  kind: JobKind;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
  /** Defer the first attempt; default now. */
  runAt?: Date;
  maxAttempts?: number;
}

export interface JobStore {
  enqueue(input: EnqueueInput): Promise<{ job: JobRow; created: boolean }>;
  leaseDue(limit: number, leaseSeconds: number): Promise<JobRow[]>;
  leaseById(id: string, leaseSeconds: number): Promise<JobRow | null>;
  complete(id: string, result: unknown): Promise<JobRow | null>;
  fail(id: string, error: string, opts?: { park?: boolean }): Promise<JobRow | null>;
  release(id: string): Promise<JobRow | null>;
  get(id: string): Promise<JobRow | null>;
  list(filter?: { status?: JobStatus; limit?: number }): Promise<JobRow[]>;
}

export const neonJobStore: JobStore = {
  async enqueue(input) {
    if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
    await ensureJobsSchema();
    const q = sql();
    const inserted = (await q.query(
      `INSERT INTO crm_jobs (kind, idempotency_key, payload, created_by, next_attempt_at, max_attempts)
       VALUES ($1, $2, $3::jsonb, $4, COALESCE($5::timestamptz, NOW()), COALESCE($6::int, 20))
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.kind,
        input.idempotencyKey,
        JSON.stringify(input.payload ?? {}),
        input.createdBy ?? null,
        input.runAt ? input.runAt.toISOString() : null,
        input.maxAttempts ?? null,
      ],
    )) as JobRowRaw[];
    if (inserted[0]) return { job: mapJobRow(inserted[0]), created: true };
    const existing = (await q.query(`SELECT ${COLUMNS} FROM crm_jobs WHERE idempotency_key = $1`, [
      input.idempotencyKey,
    ])) as JobRowRaw[];
    if (!existing[0]) throw new Error(`crm_jobs: enqueue of ${input.idempotencyKey} vanished`);
    return { job: mapJobRow(existing[0]), created: false };
  },

  async leaseDue(limit, leaseSeconds) {
    if (!isDbConfigured()) return [];
    await ensureJobsSchema();
    const q = sql();
    const rows = (await q.query(
      `UPDATE crm_jobs AS j
          SET status = 'running',
              leased_until = NOW() + make_interval(secs => $2),
              attempts = j.attempts + 1,
              updated_at = NOW()
        WHERE j.id IN (
          SELECT id FROM crm_jobs
           WHERE (status IN ('pending','failed') AND next_attempt_at <= NOW())
              OR (status = 'running' AND leased_until IS NOT NULL AND leased_until < NOW())
           ORDER BY next_attempt_at ASC, id ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${COLUMNS}`,
      [Math.max(1, Math.min(limit, 200)), Math.max(1, leaseSeconds)],
    )) as JobRowRaw[];
    return rows.map(mapJobRow);
  },

  async leaseById(id, leaseSeconds) {
    if (!isDbConfigured()) return null;
    await ensureJobsSchema();
    const q = sql();
    const rows = (await q.query(
      `UPDATE crm_jobs
          SET status = 'running',
              leased_until = NOW() + make_interval(secs => $2),
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = $1::bigint AND status IN ('pending','failed','parked','running')
        RETURNING ${COLUMNS}`,
      [id, Math.max(1, leaseSeconds)],
    )) as JobRowRaw[];
    return rows[0] ? mapJobRow(rows[0]) : null;
  },

  async complete(id, result) {
    if (!isDbConfigured()) return null;
    await ensureJobsSchema();
    const q = sql();
    const rows = (await q.query(
      `UPDATE crm_jobs
          SET status = 'done', result = $2::jsonb, last_error = NULL, leased_until = NULL,
              resolved_at = NOW(), updated_at = NOW()
        WHERE id = $1::bigint
        RETURNING ${COLUMNS}`,
      [id, JSON.stringify(result ?? null)],
    )) as JobRowRaw[];
    return rows[0] ? mapJobRow(rows[0]) : null;
  },

  async fail(id, error, opts = {}) {
    if (!isDbConfigured()) return null;
    await ensureJobsSchema();
    const q = sql();
    const rows = (await q.query(
      `UPDATE crm_jobs
          SET status = CASE WHEN $3::boolean OR attempts >= max_attempts THEN 'parked' ELSE 'failed' END,
              next_attempt_at = NOW() + make_interval(secs => LEAST(${MAX_BACKOFF_SECONDS}, ${BACKOFF_STEP_SECONDS} * GREATEST(attempts, 1))),
              last_error = $2,
              result = jsonb_build_object('ok', false, 'error', $2::text),
              leased_until = NULL,
              resolved_at = CASE WHEN $3::boolean OR attempts >= max_attempts THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE id = $1::bigint
        RETURNING ${COLUMNS}`,
      [id, error.slice(0, 2000), opts.park === true],
    )) as JobRowRaw[];
    return rows[0] ? mapJobRow(rows[0]) : null;
  },

  async release(id) {
    if (!isDbConfigured()) return null;
    await ensureJobsSchema();
    const q = sql();
    const rows = (await q.query(
      `UPDATE crm_jobs
          SET status = 'pending', leased_until = NULL,
              attempts = GREATEST(attempts - 1, 0), updated_at = NOW()
        WHERE id = $1::bigint AND status = 'running'
        RETURNING ${COLUMNS}`,
      [id],
    )) as JobRowRaw[];
    return rows[0] ? mapJobRow(rows[0]) : null;
  },

  async get(id) {
    if (!isDbConfigured()) return null;
    await ensureJobsSchema();
    const q = sql();
    const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_jobs WHERE id = $1::bigint`, [
      id,
    ])) as JobRowRaw[];
    return rows[0] ? mapJobRow(rows[0]) : null;
  },

  async list(filter = {}) {
    if (!isDbConfigured()) return [];
    await ensureJobsSchema();
    const q = sql();
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200);
    const rows = (await q.query(
      `SELECT ${COLUMNS} FROM crm_jobs
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY updated_at DESC, id DESC
        LIMIT $2`,
      [filter.status ?? null, limit],
    )) as JobRowRaw[];
    return rows.map(mapJobRow);
  },
};

/**
 * One job by its idempotency key — "is the retry for X still outstanding?".
 *
 * Deliberately NOT a method on `JobStore`: that interface is implemented by
 * the runner's in-memory fake, and widening it would make every implementor
 * grow a method only one caller wants. A standalone read against the same
 * table is honest about being exactly that.
 */
export async function getJobByIdempotencyKey(key: string): Promise<JobRow | null> {
  if (!isDbConfigured()) return null;
  await ensureJobsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_jobs WHERE idempotency_key = $1`, [
    key,
  ])) as JobRowRaw[];
  return rows[0] ? mapJobRow(rows[0]) : null;
}
