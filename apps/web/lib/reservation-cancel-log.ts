/**
 * Durable audit log for reservation cancellations (refund OR store-credit).
 *
 * One row per cancellation ATTEMPT (cascade), keyed by cascade_id. The table
 * serves three jobs:
 *
 *  1. Audit — what the cascade planned (plan JSONB), what each step actually
 *     did (step_log JSONB), and how the money settled (refund ids / GAN).
 *     Money-moving incidents get diagnosed from here, not from console logs.
 *  2. Attempt counter — Square idempotency keys are derived from
 *     `cxl-{anchorId}-a{attempt}`. A FAILED attempt burns its key namespace
 *     (Square remembers failed idempotency keys), so the next attempt bumps
 *     the counter. A crashed-but-not-failed attempt ('started') keeps its
 *     namespace so a resume replays the same keys safely.
 *  3. Resume registry — `resumeTeardown` looks up the latest event to re-run
 *     best-effort teardown after a crash between commit and completion.
 *
 * Mirrors the lazy CREATE TABLE IF NOT EXISTS pattern of bmi-cancel-log.ts
 * (no migrations framework in this repo).
 */
import { neon } from "@neondatabase/serverless";

function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
function sql() {
  return neon(process.env.DATABASE_URL!);
}

export type CancelEventState = "started" | "completed" | "failed";

export interface CancelEventStart {
  cascadeId: string;
  anchorReservationId: number;
  legIds: number[];
  outcome: "refund" | "store_credit" | "none";
  actor: "customer" | "admin";
  attempt: number;
  /** The dry-run plan the cascade is about to execute (PlannedStep[]). */
  plan: unknown;
}

export interface CancelEventFinish {
  state: Exclude<CancelEventState, "started">;
  refundCents?: number;
  refundIds?: string[];
  storeCreditGiftCardId?: string;
  storeCreditGan?: string;
  /** Ordered per-step results incl. warnings from best-effort teardown. */
  stepLog?: unknown;
  error?: string;
}

export interface CancelEventRow {
  id: number;
  cascadeId: string;
  anchorReservationId: number;
  legIds: number[];
  outcome: string;
  actor: string;
  attempt: number;
  state: CancelEventState;
  refundCents: number | null;
  refundIds: string[] | null;
  storeCreditGiftCardId: string | null;
  storeCreditGan: string | null;
  plan: unknown;
  stepLog: unknown;
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
    CREATE TABLE IF NOT EXISTS reservation_cancel_events (
      id BIGSERIAL PRIMARY KEY,
      cascade_id TEXT NOT NULL UNIQUE,
      anchor_reservation_id INTEGER NOT NULL,
      leg_ids INTEGER[] NOT NULL,
      outcome TEXT NOT NULL,
      actor TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL,
      refund_cents INTEGER,
      refund_ids TEXT[],
      store_credit_gift_card_id TEXT,
      store_credit_gan TEXT,
      plan JSONB,
      step_log JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS rce_res ON reservation_cancel_events (anchor_reservation_id)`;
  schemaReady = true;
}

/**
 * Attempt number for the next cascade run against this reservation:
 * 1 + count of FAILED prior attempts. 'started' rows (crashes) do NOT bump
 * the attempt — resuming them must replay the same idempotency keys.
 */
export async function nextCancelAttempt(anchorReservationId: number): Promise<number> {
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT COUNT(*)::int AS failed FROM reservation_cancel_events
    WHERE anchor_reservation_id = ${anchorReservationId} AND state = 'failed'
  `;
  return ((rows[0]?.failed as number) ?? 0) + 1;
}

/**
 * Record the start of a cascade. Upserts on cascade_id so a resume of a
 * crashed attempt refreshes the plan instead of erroring. THROWS on failure —
 * the cascade must not move money without its audit row.
 */
export async function startCancelEvent(ev: CancelEventStart): Promise<void> {
  if (!isDbConfigured()) {
    throw new Error("reservation-cancel-log: DATABASE_URL not configured");
  }
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO reservation_cancel_events (
      cascade_id, anchor_reservation_id, leg_ids, outcome, actor, attempt, state, plan
    ) VALUES (
      ${ev.cascadeId}, ${ev.anchorReservationId}, ${ev.legIds}, ${ev.outcome},
      ${ev.actor}, ${ev.attempt}, 'started', ${JSON.stringify(ev.plan)}
    )
    ON CONFLICT (cascade_id) DO UPDATE SET
      state = 'started',
      plan = EXCLUDED.plan,
      error = NULL
  `;
}

/**
 * Record the cascade's terminal state. Logs + swallows failures — by the time
 * this runs the cancel has already committed; a logging error must not
 * surface as a cancel error.
 */
export async function finishCancelEvent(cascadeId: string, fin: CancelEventFinish): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      UPDATE reservation_cancel_events SET
        state = ${fin.state},
        refund_cents = COALESCE(${fin.refundCents ?? null}, refund_cents),
        refund_ids = COALESCE(${fin.refundIds ?? null}, refund_ids),
        store_credit_gift_card_id = COALESCE(${fin.storeCreditGiftCardId ?? null}, store_credit_gift_card_id),
        store_credit_gan = COALESCE(${fin.storeCreditGan ?? null}, store_credit_gan),
        step_log = COALESCE(${fin.stepLog ? JSON.stringify(fin.stepLog) : null}, step_log),
        error = ${fin.error ?? null},
        completed_at = NOW()
      WHERE cascade_id = ${cascadeId}
    `;
  } catch (err) {
    console.error(
      `[reservation-cancel-log] finish failed cascade=${cascadeId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToEvent(r: any): CancelEventRow {
  return {
    id: r.id,
    cascadeId: r.cascade_id,
    anchorReservationId: r.anchor_reservation_id,
    legIds: r.leg_ids ?? [],
    outcome: r.outcome,
    actor: r.actor,
    attempt: r.attempt,
    state: r.state,
    refundCents: r.refund_cents,
    refundIds: r.refund_ids,
    storeCreditGiftCardId: r.store_credit_gift_card_id,
    storeCreditGan: r.store_credit_gan,
    plan: r.plan,
    stepLog: r.step_log,
    error: r.error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Latest cancel event for a reservation (any leg as anchor) — resume + admin display. */
export async function getLatestCancelEvent(
  anchorReservationId: number,
): Promise<CancelEventRow | null> {
  if (!isDbConfigured()) return null;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM reservation_cancel_events
      WHERE anchor_reservation_id = ${anchorReservationId}
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows.length ? rowToEvent(rows[0]) : null;
  } catch {
    return null;
  }
}

/** Recent cancellations for admin/incident review. */
export async function listCancelEvents(limit = 100): Promise<CancelEventRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM reservation_cancel_events ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(rowToEvent);
  } catch {
    return [];
  }
}
