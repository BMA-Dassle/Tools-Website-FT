/**
 * Durable audit log for RESERVE attempts — our own record of every booking
 * fan-out, especially the ones that died after the money moved.
 *
 * Why this exists: on 2026-07-28 a FastTrax kiosk captured $234.21 and then
 * threw on a QAMF 400. Reconstructing it took a Vercel log dig (queries time out
 * on any window wider than ~3 minutes, retention is short, vendor bodies were
 * truncated to 200 chars) plus a lucky Redis TTL that hadn't expired yet. There
 * was no way to ask "what happened to bill X" or "show me today's captured-but-
 * unreserved bookings". Now there is.
 *
 * One row per reserve ATTEMPT (the terminal path retries up to 3×, so a single
 * guest interaction can produce three rows sharing a base_key — that history is
 * the point: attempt 1 failed at QAMF, attempts 2-3 failed EARLIER, at gift-card
 * activation, which is how the non-idempotent replay was spotted).
 *
 * Writes NEVER throw. Guest data already has its own persist-first guarantees
 * (Redis booking record, BMI bill, bowling_reservations); this is forensics on
 * top, and a logging outage must not become a booking outage on the primary
 * revenue path.
 */
import { neon } from "@neondatabase/serverless";

function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
function sql() {
  return neon(process.env.DATABASE_URL!);
}

export type ReserveAttemptState = "started" | "completed" | "failed";

/** Cart shape at reserve time — enough to replay the decision, no extra PII. */
export interface ReserveCartSnapshot {
  items: Array<{
    kind: string;
    id: string;
    date?: string | null;
    /** bowling/kbf slot fields — the ones bookability turns on. */
    bookedAt?: string | null;
    webOfferId?: number | null;
    qamfReservationId?: string | null;
    qamfCenterId?: number | null;
    isDuckpin?: boolean;
    /** race: how many heats are attached. */
    heatCount?: number;
    /** attraction slug. */
    slug?: string | null;
  }>;
  packCount?: number;
  comboSpecialId?: string | null;
}

export interface ReserveAttemptStart {
  /** Deterministic Square idempotency seed for this session (reserveBaseKey). */
  baseKey: string;
  billId?: string | null;
  surface: "web" | "kiosk";
  center?: string | null;
  locationId?: string | null;
  /** "terminal" (reader already captured) | "card" | "credit". */
  paymentSource: string;
  chargeCents: number;
  cart: ReserveCartSnapshot;
  /** Legs the bookability guard refused to send to QAMF. */
  droppedLegs?: string[];
}

export interface ReserveAttemptFinish {
  state: Exclude<ReserveAttemptState, "started">;
  depositOrderId?: string | null;
  depositPaymentId?: string | null;
  neonIds?: number[];
  qamfReservationIds?: string[];
  bmiReservationNumber?: string | null;
  /** Which step blew up — "qamf-confirm", "gift-card-activate", "bmi-confirm"… */
  failedStep?: string | null;
  /** FULL error text. Never truncate here; truncation is what cost us last time. */
  error?: string | null;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS reserve_attempts (
      id BIGSERIAL PRIMARY KEY,
      base_key TEXT NOT NULL,
      bill_id TEXT,
      surface TEXT NOT NULL,
      center TEXT,
      location_id TEXT,
      payment_source TEXT NOT NULL,
      charge_cents INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      cart JSONB,
      dropped_legs TEXT[],
      deposit_order_id TEXT,
      deposit_payment_id TEXT,
      neon_ids INTEGER[],
      qamf_reservation_ids TEXT[],
      bmi_reservation_number TEXT,
      failed_step TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS ra_base ON reserve_attempts (base_key)`;
  await q`CREATE INDEX IF NOT EXISTS ra_bill ON reserve_attempts (bill_id)`;
  // The money-at-risk query: captured payment, no completed attempt.
  await q`CREATE INDEX IF NOT EXISTS ra_state_created ON reserve_attempts (state, created_at DESC)`;
  schemaReady = true;
}

/**
 * Open an attempt row. Returns its id for the matching finish call, or null when
 * logging is unavailable (callers treat null as "don't bother finishing").
 */
export async function startReserveAttempt(ev: ReserveAttemptStart): Promise<number | null> {
  if (!isDbConfigured()) return null;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      INSERT INTO reserve_attempts (
        base_key, bill_id, surface, center, location_id, payment_source,
        charge_cents, state, cart, dropped_legs
      ) VALUES (
        ${ev.baseKey}, ${ev.billId ?? null}, ${ev.surface}, ${ev.center ?? null},
        ${ev.locationId ?? null}, ${ev.paymentSource}, ${ev.chargeCents}, 'started',
        ${JSON.stringify(ev.cart)}, ${ev.droppedLegs ?? null}
      )
      RETURNING id
    `;
    return (rows[0]?.id as number) ?? null;
  } catch (err) {
    console.error(
      "[reserve-attempt-log] start failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Stamp the captured deposit ids the moment the charge lands — before any
 * downstream vendor step. Forward-recovery doctrine: if the process dies on the
 * next line, the money still has a durable, queryable anchor of its own.
 */
export async function recordReserveCapture(
  attemptId: number | null,
  ids: { depositOrderId?: string | null; depositPaymentId?: string | null },
): Promise<void> {
  if (attemptId == null || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      UPDATE reserve_attempts SET
        deposit_order_id = COALESCE(${ids.depositOrderId ?? null}, deposit_order_id),
        deposit_payment_id = COALESCE(${ids.depositPaymentId ?? null}, deposit_payment_id)
      WHERE id = ${attemptId}
    `;
  } catch (err) {
    console.error(
      "[reserve-attempt-log] capture stamp failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Record the attempt's terminal state. Logs + swallows its own failures. */
export async function finishReserveAttempt(
  attemptId: number | null,
  fin: ReserveAttemptFinish,
): Promise<void> {
  if (attemptId == null || !isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      UPDATE reserve_attempts SET
        state = ${fin.state},
        deposit_order_id = COALESCE(${fin.depositOrderId ?? null}, deposit_order_id),
        deposit_payment_id = COALESCE(${fin.depositPaymentId ?? null}, deposit_payment_id),
        neon_ids = COALESCE(${fin.neonIds ?? null}, neon_ids),
        qamf_reservation_ids = COALESCE(${fin.qamfReservationIds ?? null}, qamf_reservation_ids),
        bmi_reservation_number = COALESCE(${fin.bmiReservationNumber ?? null}, bmi_reservation_number),
        failed_step = ${fin.failedStep ?? null},
        error = ${fin.error ?? null},
        completed_at = NOW()
      WHERE id = ${attemptId}
    `;
  } catch (err) {
    console.error(
      "[reserve-attempt-log] finish failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

export interface ReserveAttemptRow {
  id: number;
  baseKey: string;
  billId: string | null;
  surface: string;
  center: string | null;
  locationId: string | null;
  paymentSource: string;
  chargeCents: number;
  state: ReserveAttemptState;
  cart: ReserveCartSnapshot | null;
  droppedLegs: string[] | null;
  depositOrderId: string | null;
  depositPaymentId: string | null;
  neonIds: number[] | null;
  qamfReservationIds: string[] | null;
  bmiReservationNumber: string | null;
  failedStep: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToAttempt(r: any): ReserveAttemptRow {
  return {
    id: r.id,
    baseKey: r.base_key,
    billId: r.bill_id,
    surface: r.surface,
    center: r.center,
    locationId: r.location_id,
    paymentSource: r.payment_source,
    chargeCents: r.charge_cents ?? 0,
    state: r.state,
    cart: r.cart,
    droppedLegs: r.dropped_legs,
    depositOrderId: r.deposit_order_id,
    depositPaymentId: r.deposit_payment_id,
    neonIds: r.neon_ids,
    qamfReservationIds: r.qamf_reservation_ids,
    bmiReservationNumber: r.bmi_reservation_number,
    failedStep: r.failed_step,
    error: r.error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every attempt against a BMI bill, newest first — "what happened to bill X". */
export async function listReserveAttemptsByBill(billId: string): Promise<ReserveAttemptRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM reserve_attempts WHERE bill_id = ${billId}
      ORDER BY created_at DESC LIMIT 50
    `;
    return rows.map(rowToAttempt);
  } catch {
    return [];
  }
}

/**
 * Money at risk: attempts that captured a payment and never completed, with no
 * LATER completed attempt sharing their base_key (the retry loop's earlier
 * failures are not orphans if a later attempt succeeded).
 */
export async function listCapturedUnreserved(hours = 72): Promise<ReserveAttemptRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT a.* FROM reserve_attempts a
      WHERE a.deposit_payment_id IS NOT NULL
        AND a.state <> 'completed'
        AND a.created_at > NOW() - (${hours} || ' hours')::interval
        AND NOT EXISTS (
          SELECT 1 FROM reserve_attempts b
          WHERE b.base_key = a.base_key AND b.state = 'completed'
        )
      ORDER BY a.created_at DESC LIMIT 200
    `;
    return rows.map(rowToAttempt);
  } catch (err) {
    console.error(
      "[reserve-attempt-log] captured-unreserved query failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Recent failures for a quick "what's breaking today" read. */
export async function listRecentReserveFailures(limit = 50): Promise<ReserveAttemptRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM reserve_attempts WHERE state = 'failed'
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(rowToAttempt);
  } catch {
    return [];
  }
}
