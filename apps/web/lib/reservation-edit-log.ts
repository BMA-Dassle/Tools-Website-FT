/**
 * Durable audit log + money ledger for reservation EDITS.
 *
 * One row per edit ATTEMPT, keyed by edit_id (`edit-{anchorId}-a{attempt}`).
 * Mirrors reservation-cancel-log.ts (same three jobs):
 *
 *  1. Audit — the dry-run plan (plan JSONB), per-step results (step_log),
 *     and how the money moved (payment_ids / refund_ids / GAN).
 *  2. Attempt counter — Square idempotency keys derive from the edit_id.
 *     FAILED attempts burn their key namespace → next attempt bumps; crashed
 *     'started' attempts keep their namespace so a resume replays safely.
 *     'pending_payment' attempts (self-hosted payment-link edits) also keep
 *     their namespace — the link completion runs the SAME attempt.
 *  3. Cancel-awareness input — the cancellation planner reads completed edit
 *     payments from here so a later cancel refunds edit top-ups too.
 */
import { neon } from "@neondatabase/serverless";

function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
function sql() {
  return neon(process.env.DATABASE_URL!);
}

export type EditEventState = "started" | "pending_payment" | "completed" | "failed";

export interface EditEventStart {
  editId: string;
  anchorReservationId: number;
  legIds: number[];
  phase: "pre" | "mid" | "post_complete";
  diffCents: number;
  settlement: "charge" | "card_refund" | "store_credit" | "none";
  actor: string;
  attempt: number;
  /** The EditSpec requested. */
  spec: unknown;
  /** The dry-run plan the cascade is about to execute. */
  plan: unknown;
}

export interface EditEventFinish {
  state: Exclude<EditEventState, "started">;
  paymentIds?: string[];
  refundIds?: string[];
  storeCreditGiftCardId?: string;
  storeCreditGan?: string;
  oldDayofOrderId?: string;
  newDayofOrderId?: string;
  stepLog?: unknown;
  error?: string;
}

export interface EditEventRow {
  id: number;
  editId: string;
  anchorReservationId: number;
  legIds: number[];
  phase: string;
  diffCents: number;
  settlement: string;
  actor: string;
  attempt: number;
  state: EditEventState;
  paymentIds: string[] | null;
  refundIds: string[] | null;
  storeCreditGiftCardId: string | null;
  storeCreditGan: string | null;
  oldDayofOrderId: string | null;
  newDayofOrderId: string | null;
  spec: unknown;
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
    CREATE TABLE IF NOT EXISTS reservation_edit_events (
      id BIGSERIAL PRIMARY KEY,
      edit_id TEXT NOT NULL UNIQUE,
      anchor_reservation_id INTEGER NOT NULL,
      leg_ids INTEGER[] NOT NULL,
      phase TEXT NOT NULL,
      diff_cents INTEGER NOT NULL DEFAULT 0,
      settlement TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'admin',
      attempt INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL,
      payment_ids TEXT[],
      refund_ids TEXT[],
      store_credit_gift_card_id TEXT,
      store_credit_gan TEXT,
      old_dayof_order_id TEXT,
      new_dayof_order_id TEXT,
      spec JSONB,
      plan JSONB,
      step_log JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS ree_res ON reservation_edit_events (anchor_reservation_id)`;
  schemaReady = true;
}

/**
 * Attempt number for the next edit against this reservation: 1 + count of
 * FAILED prior attempts. 'started' and 'pending_payment' rows keep their key
 * namespace (resume/link-completion replays the same idempotency keys).
 */
export async function nextEditAttempt(anchorReservationId: number): Promise<number> {
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT COUNT(*)::int AS failed FROM reservation_edit_events
    WHERE anchor_reservation_id = ${anchorReservationId} AND state = 'failed'
  `;
  return ((rows[0]?.failed as number) ?? 0) + 1;
}

/**
 * Record the start of an edit cascade. Upserts on edit_id so a resume of a
 * crashed/pending attempt refreshes the plan instead of erroring. THROWS on
 * failure — the cascade must not move money without its audit row.
 */
export async function startEditEvent(ev: EditEventStart): Promise<void> {
  if (!isDbConfigured()) {
    throw new Error("reservation-edit-log: DATABASE_URL not configured");
  }
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO reservation_edit_events (
      edit_id, anchor_reservation_id, leg_ids, phase, diff_cents, settlement,
      actor, attempt, state, spec, plan
    ) VALUES (
      ${ev.editId}, ${ev.anchorReservationId}, ${ev.legIds}, ${ev.phase},
      ${ev.diffCents}, ${ev.settlement}, ${ev.actor}, ${ev.attempt}, 'started',
      ${JSON.stringify(ev.spec)}, ${JSON.stringify(ev.plan)}
    )
    ON CONFLICT (edit_id) DO UPDATE SET
      state = 'started',
      diff_cents = EXCLUDED.diff_cents,
      settlement = EXCLUDED.settlement,
      spec = EXCLUDED.spec,
      plan = EXCLUDED.plan,
      error = NULL
  `;
}

/**
 * Persist a captured payment id IMMEDIATELY after the charge lands — before
 * any downstream step. Forward-recovery doctrine: captured money always has a
 * durable anchor even if the process dies on the very next line.
 */
export async function recordEditPayment(editId: string, paymentId: string): Promise<void> {
  if (!isDbConfigured()) throw new Error("reservation-edit-log: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE reservation_edit_events
    SET payment_ids = array_append(COALESCE(payment_ids, '{}'), ${paymentId})
    WHERE edit_id = ${editId}
      AND NOT (${paymentId} = ANY(COALESCE(payment_ids, '{}')))
  `;
}

/** Flip a started row to pending_payment (self-hosted payment-link edits). */
export async function markEditPendingPayment(editId: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE reservation_edit_events SET state = 'pending_payment'
    WHERE edit_id = ${editId} AND state = 'started'
  `;
}

/**
 * Record the edit's terminal state. Logs + swallows failures — by the time
 * this runs the edit has already committed; a logging error must not surface
 * as an edit error.
 */
export async function finishEditEvent(editId: string, fin: EditEventFinish): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      UPDATE reservation_edit_events SET
        state = ${fin.state},
        payment_ids = COALESCE(${fin.paymentIds ?? null}, payment_ids),
        refund_ids = COALESCE(${fin.refundIds ?? null}, refund_ids),
        store_credit_gift_card_id = COALESCE(${fin.storeCreditGiftCardId ?? null}, store_credit_gift_card_id),
        store_credit_gan = COALESCE(${fin.storeCreditGan ?? null}, store_credit_gan),
        old_dayof_order_id = COALESCE(${fin.oldDayofOrderId ?? null}, old_dayof_order_id),
        new_dayof_order_id = COALESCE(${fin.newDayofOrderId ?? null}, new_dayof_order_id),
        step_log = COALESCE(${fin.stepLog ? JSON.stringify(fin.stepLog) : null}, step_log),
        error = ${fin.error ?? null},
        completed_at = NOW()
      WHERE edit_id = ${editId}
    `;
  } catch (err) {
    console.error(
      `[reservation-edit-log] finish failed edit=${editId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToEvent(r: any): EditEventRow {
  return {
    id: r.id,
    editId: r.edit_id,
    anchorReservationId: r.anchor_reservation_id,
    legIds: r.leg_ids ?? [],
    phase: r.phase,
    diffCents: r.diff_cents ?? 0,
    settlement: r.settlement,
    actor: r.actor,
    attempt: r.attempt,
    state: r.state,
    paymentIds: r.payment_ids,
    refundIds: r.refund_ids,
    storeCreditGiftCardId: r.store_credit_gift_card_id,
    storeCreditGan: r.store_credit_gan,
    oldDayofOrderId: r.old_dayof_order_id,
    newDayofOrderId: r.new_dayof_order_id,
    spec: r.spec,
    plan: r.plan,
    stepLog: r.step_log,
    error: r.error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Latest edit event for a reservation — resume + admin display. */
export async function getLatestEditEvent(
  anchorReservationId: number,
): Promise<EditEventRow | null> {
  if (!isDbConfigured()) return null;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM reservation_edit_events
      WHERE anchor_reservation_id = ${anchorReservationId}
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows.length ? rowToEvent(rows[0]) : null;
  } catch {
    return null;
  }
}

/** Fetch one event by edit_id (payment-link completion path). */
export async function getEditEvent(editId: string): Promise<EditEventRow | null> {
  if (!isDbConfigured()) return null;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM reservation_edit_events WHERE edit_id = ${editId} LIMIT 1
    `;
    return rows.length ? rowToEvent(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * All edit events touching ANY of the given reservation ids (anchor or leg).
 * The manage-reservation History tab merges these; the cancellation planner
 * reads completed events' payment_ids for cancel-awareness.
 */
export async function listEditEventsByAnchors(
  reservationIds: number[],
  limit = 50,
): Promise<EditEventRow[]> {
  if (!isDbConfigured() || reservationIds.length === 0) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM reservation_edit_events
      WHERE anchor_reservation_id = ANY(${reservationIds})
         OR leg_ids && ${reservationIds}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(rowToEvent);
  } catch {
    return [];
  }
}

/** True when an edit attempt is currently in flight for any of these rows. */
export async function hasOpenEditEvent(reservationIds: number[]): Promise<boolean> {
  if (!isDbConfigured() || reservationIds.length === 0) return false;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT 1 FROM reservation_edit_events
      WHERE (anchor_reservation_id = ANY(${reservationIds}) OR leg_ids && ${reservationIds})
        AND state IN ('started', 'pending_payment')
        AND created_at > NOW() - INTERVAL '48 hours'
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}
