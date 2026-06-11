/**
 * Durable BMI evidence log for the "charged but empty" defect.
 *
 * BMI auto-cancels a Pending-Online hold after the center's timeout and STRIPS
 * the bill's products/schedule — even after a successful Square charge (the
 * payment/confirm doesn't register, so BMI treats the hold as unpaid). The
 * customer is left charged with no live reservation.
 *
 * This table is the irrefutable record we hand BMI: for every paid race booking
 * we find system-cancelled, it captures the bill, the Square payment, the BMI
 * project/schedule state, who cancelled it (userUpdatedId = -1 → SYSTEM), and
 * what we did about it (detected / alerted / rebuilt). One row per bill,
 * upserted on each scan so re-detections don't spam.
 *
 * Mirrors the lazy `CREATE TABLE IF NOT EXISTS` + UPSERT pattern of
 * bmi-deposit-retry.ts (no migrations framework in this repo).
 */
import { neon } from "@neondatabase/serverless";

function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
function sql() {
  return neon(process.env.DATABASE_URL!);
}

export type BmiCancelClassification = "system_cancel" | "user_cancel" | "live" | "unknown";
export type BmiCancelAction =
  | "detected"
  | "alerted"
  | "rebuilt"
  | "rebuild_failed"
  | "rebuild_skipped";

export interface BmiCancelEvent {
  billId: string;
  reservationNumber?: string | null;
  productKind?: string | null;
  /** Heat start as stored by BMI (naked-local ET ISO). */
  heatStart?: string | null;
  isFuture: boolean;
  guestName?: string | null;
  guestPhone?: string | null;
  squarePaymentId?: string | null;
  squareOrderId?: string | null;
  amountCents?: number | null;
  refundedCents?: number | null;
  classification: BmiCancelClassification;
  projectStateId?: string | null;
  scheduleStateId?: string | null;
  userUpdatedId?: string | null;
  productsCount?: number | null;
  action: BmiCancelAction;
  rebuildBillId?: string | null;
  notes?: string | null;
  /** Full evidence snapshot (BMI project + overview + Square payment). */
  raw?: unknown;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS bmi_cancel_events (
      id BIGSERIAL PRIMARY KEY,
      bill_id TEXT NOT NULL,
      reservation_number TEXT,
      product_kind TEXT,
      heat_start TEXT,
      is_future BOOLEAN NOT NULL DEFAULT FALSE,
      guest_name TEXT,
      guest_phone TEXT,
      square_payment_id TEXT,
      square_order_id TEXT,
      amount_cents INTEGER,
      refunded_cents INTEGER,
      classification TEXT NOT NULL,
      project_state_id TEXT,
      schedule_state_id TEXT,
      user_updated_id TEXT,
      products_count INTEGER,
      action TEXT NOT NULL,
      rebuild_bill_id TEXT,
      first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      notes TEXT,
      raw JSONB
    )
  `;
  // One row per bill — re-detections UPSERT.
  await q`CREATE UNIQUE INDEX IF NOT EXISTS bmi_cancel_events_bill ON bmi_cancel_events (bill_id)`;
  await q`CREATE INDEX IF NOT EXISTS bmi_cancel_events_recent ON bmi_cancel_events (first_detected_at DESC)`;
  schemaReady = true;
}

/**
 * Upsert one bill's BMI-cancel evidence. first_detected_at is preserved across
 * re-scans; everything else (state, action, rebuild id, raw snapshot) refreshes.
 * Failures are logged + swallowed — evidence logging must never break the cron.
 */
export async function logBmiCancelEvent(ev: BmiCancelEvent): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO bmi_cancel_events (
        bill_id, reservation_number, product_kind, heat_start, is_future,
        guest_name, guest_phone, square_payment_id, square_order_id,
        amount_cents, refunded_cents, classification, project_state_id,
        schedule_state_id, user_updated_id, products_count, action,
        rebuild_bill_id, notes, raw
      ) VALUES (
        ${ev.billId}, ${ev.reservationNumber ?? null}, ${ev.productKind ?? null},
        ${ev.heatStart ?? null}, ${ev.isFuture}, ${ev.guestName ?? null},
        ${ev.guestPhone ?? null}, ${ev.squarePaymentId ?? null}, ${ev.squareOrderId ?? null},
        ${ev.amountCents ?? null}, ${ev.refundedCents ?? null}, ${ev.classification},
        ${ev.projectStateId ?? null}, ${ev.scheduleStateId ?? null}, ${ev.userUpdatedId ?? null},
        ${ev.productsCount ?? null}, ${ev.action}, ${ev.rebuildBillId ?? null},
        ${ev.notes ?? null}, ${ev.raw ? JSON.stringify(ev.raw) : null}
      )
      ON CONFLICT (bill_id) DO UPDATE SET
        reservation_number = COALESCE(EXCLUDED.reservation_number, bmi_cancel_events.reservation_number),
        product_kind = COALESCE(EXCLUDED.product_kind, bmi_cancel_events.product_kind),
        heat_start = COALESCE(EXCLUDED.heat_start, bmi_cancel_events.heat_start),
        is_future = EXCLUDED.is_future,
        guest_name = COALESCE(EXCLUDED.guest_name, bmi_cancel_events.guest_name),
        guest_phone = COALESCE(EXCLUDED.guest_phone, bmi_cancel_events.guest_phone),
        square_payment_id = COALESCE(EXCLUDED.square_payment_id, bmi_cancel_events.square_payment_id),
        square_order_id = COALESCE(EXCLUDED.square_order_id, bmi_cancel_events.square_order_id),
        amount_cents = COALESCE(EXCLUDED.amount_cents, bmi_cancel_events.amount_cents),
        refunded_cents = COALESCE(EXCLUDED.refunded_cents, bmi_cancel_events.refunded_cents),
        classification = EXCLUDED.classification,
        project_state_id = EXCLUDED.project_state_id,
        schedule_state_id = EXCLUDED.schedule_state_id,
        user_updated_id = EXCLUDED.user_updated_id,
        products_count = EXCLUDED.products_count,
        action = EXCLUDED.action,
        rebuild_bill_id = COALESCE(EXCLUDED.rebuild_bill_id, bmi_cancel_events.rebuild_bill_id),
        last_seen_at = NOW(),
        notes = COALESCE(EXCLUDED.notes, bmi_cancel_events.notes),
        raw = COALESCE(EXCLUDED.raw, bmi_cancel_events.raw)
    `;
  } catch (err) {
    console.error("[bmi-cancel-log] insert failed:", err instanceof Error ? err.message : err);
  }
}

export interface BmiCancelRow extends BmiCancelEvent {
  id: number;
  firstDetectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

/** Recent evidence rows for the admin board / BMI export. */
export async function listBmiCancelEvents(limit = 200): Promise<BmiCancelRow[]> {
  if (!isDbConfigured()) return [];
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM bmi_cancel_events ORDER BY first_detected_at DESC LIMIT ${limit}
    `;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({
      id: r.id,
      billId: r.bill_id,
      reservationNumber: r.reservation_number,
      productKind: r.product_kind,
      heatStart: r.heat_start,
      isFuture: r.is_future,
      guestName: r.guest_name,
      guestPhone: r.guest_phone,
      squarePaymentId: r.square_payment_id,
      squareOrderId: r.square_order_id,
      amountCents: r.amount_cents,
      refundedCents: r.refunded_cents,
      classification: r.classification,
      projectStateId: r.project_state_id,
      scheduleStateId: r.schedule_state_id,
      userUpdatedId: r.user_updated_id,
      productsCount: r.products_count,
      action: r.action,
      rebuildBillId: r.rebuild_bill_id,
      firstDetectedAt: r.first_detected_at,
      lastSeenAt: r.last_seen_at,
      resolvedAt: r.resolved_at,
      notes: r.notes,
      raw: r.raw,
    }));
  } catch {
    return [];
  }
}
