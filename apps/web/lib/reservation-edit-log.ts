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
  /** Manager-severity warning codes staff acknowledged before Execute. */
  acknowledged?: EditEventAcknowledged | null;
}

/** Who acknowledged which "Conqueror/BMI will not be updated" warnings. */
export interface EditEventAcknowledged {
  codes: string[];
  /** Staff initials typed into the modal; null on the pay-link resume path. */
  by: string | null;
  at: string;
}

/** One by-hand follow-up recorded on the event (mirrors reservation-edit ManualStep). */
export interface EditEventManualStep {
  system: "conqueror" | "bmi" | "square" | "guest";
  code: string;
  message: string;
  predicted: boolean;
}

export interface EditEventFinish {
  state: Exclude<EditEventState, "started">;
  paymentIds?: string[];
  refundIds?: string[];
  storeCreditGiftCardId?: string;
  storeCreditGan?: string;
  storeCreditCents?: number;
  oldDayofOrderId?: string;
  newDayofOrderId?: string;
  stepLog?: unknown;
  manualSteps?: EditEventManualStep[];
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
  storeCreditCents: number | null;
  oldDayofOrderId: string | null;
  newDayofOrderId: string | null;
  returnOrderIds: string[] | null;
  spec: unknown;
  plan: unknown;
  stepLog: unknown;
  manualSteps: EditEventManualStep[] | null;
  acknowledged: EditEventAcknowledged | null;
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
  // 2026-08-24 audit additions (idempotent):
  //  - manual_steps: what a human still has to do by hand because Conqueror/BMI
  //    was not updated (predicted = acknowledged before Execute; unpredicted =
  //    a best-effort sync step failed). The record behind the acknowledgment.
  //  - acknowledged: which manager-severity warning codes staff ticked, their
  //    initials, and when.
  //  - store_credit_cents: what THIS attempt loaded/minted, so a retry can net
  //    a stranded credit the way refunds are netted.
  //  - return_order_ids: itemized return orders this attempt created, so a
  //    retry reuses them instead of minting a duplicate.
  await q`ALTER TABLE reservation_edit_events ADD COLUMN IF NOT EXISTS manual_steps JSONB`;
  await q`ALTER TABLE reservation_edit_events ADD COLUMN IF NOT EXISTS acknowledged JSONB`;
  await q`ALTER TABLE reservation_edit_events ADD COLUMN IF NOT EXISTS store_credit_cents INTEGER`;
  await q`ALTER TABLE reservation_edit_events ADD COLUMN IF NOT EXISTS return_order_ids TEXT[]`;
  schemaReady = true;
}

/**
 * Attempt number for the next edit against this reservation: 1 + count of
 * TERMINAL prior attempts (failed OR completed). 'started' and
 * 'pending_payment' rows are resumable and keep their key namespace, so they
 * are deliberately NOT counted — a resume replays the same idempotency keys.
 *
 * Counting COMPLETED rows (not just failed) is what makes a SECOND, unrelated
 * edit on the same reservation get a fresh namespace. Counting only failures
 * (the pre-2026-07-27 behavior) meant edit #2 recomputed attempt=1, reused the
 * completed edit's `edit-{id}-a1` namespace, and then: startEditEvent's upsert
 * flipped the finished row back to 'started' (clobbering its spec/plan while
 * keeping its refund_ids), `-r90` replayed with a different amount → Square
 * rejected the idempotency reuse, `-dec` replayed the FIRST decrement's stored
 * response instead of decrementing again, and the stranded-refund netting
 * absorbed edit #1's refunds against edit #2's owed amount — refunding nothing
 * while still editing order lines. Pair this with the open-event guard
 * (getOpenEditEvent) so a crashed 'started' row is resumed, never collided
 * with.
 */
export async function nextEditAttempt(anchorReservationId: number): Promise<number> {
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT COUNT(*)::int AS terminal FROM reservation_edit_events
    WHERE anchor_reservation_id = ${anchorReservationId}
      AND state IN ('failed', 'completed')
  `;
  return ((rows[0]?.terminal as number) ?? 0) + 1;
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
      actor, attempt, state, spec, plan, acknowledged
    ) VALUES (
      ${ev.editId}, ${ev.anchorReservationId}, ${ev.legIds}, ${ev.phase},
      ${ev.diffCents}, ${ev.settlement}, ${ev.actor}, ${ev.attempt}, 'started',
      ${JSON.stringify(ev.spec)}, ${JSON.stringify(ev.plan)},
      ${ev.acknowledged ? JSON.stringify(ev.acknowledged) : null}
    )
    ON CONFLICT (edit_id) DO UPDATE SET
      state = 'started',
      diff_cents = EXCLUDED.diff_cents,
      settlement = EXCLUDED.settlement,
      spec = EXCLUDED.spec,
      plan = EXCLUDED.plan,
      acknowledged = COALESCE(EXCLUDED.acknowledged, reservation_edit_events.acknowledged),
      error = NULL
  `;
}

/**
 * Persist a store-credit card the moment it exists (minted or loaded) — same
 * forward-recovery doctrine as recordEditPayment. A crash between the Square
 * call and finishEditEvent still leaves the card on the event row, so a retry
 * can NET it instead of loading the same card twice, and the cancel planner can
 * see that the row's store-credit card belongs to an edit.
 */
export async function recordEditStoreCredit(
  editId: string,
  giftCardId: string,
  gan: string,
  cents: number,
): Promise<void> {
  if (!isDbConfigured()) throw new Error("reservation-edit-log: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE reservation_edit_events
    SET store_credit_gift_card_id = ${giftCardId},
        store_credit_gan = ${gan},
        store_credit_cents = COALESCE(store_credit_cents, 0) + ${cents}
    WHERE edit_id = ${editId}
  `;
}

/** Persist an itemized return order id the moment Square creates it. */
export async function recordEditReturnOrder(editId: string, returnOrderId: string): Promise<void> {
  if (!isDbConfigured()) throw new Error("reservation-edit-log: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE reservation_edit_events
    SET return_order_ids = array_append(COALESCE(return_order_ids, '{}'), ${returnOrderId})
    WHERE edit_id = ${editId}
      AND NOT (${returnOrderId} = ANY(COALESCE(return_order_ids, '{}')))
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

/**
 * Persist a refund id IMMEDIATELY after the refund lands — same forward-
 * recovery doctrine as recordEditPayment. Also what lets a retry NET the
 * stranded refund out of the amount still owed.
 */
export async function recordEditRefund(editId: string, refundId: string): Promise<void> {
  if (!isDbConfigured()) throw new Error("reservation-edit-log: DATABASE_URL not configured");
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE reservation_edit_events
    SET refund_ids = array_append(COALESCE(refund_ids, '{}'), ${refundId})
    WHERE edit_id = ${editId}
      AND NOT (${refundId} = ANY(COALESCE(refund_ids, '{}')))
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
        store_credit_cents = COALESCE(${fin.storeCreditCents ?? null}, store_credit_cents),
        old_dayof_order_id = COALESCE(${fin.oldDayofOrderId ?? null}, old_dayof_order_id),
        new_dayof_order_id = COALESCE(${fin.newDayofOrderId ?? null}, new_dayof_order_id),
        step_log = COALESCE(${fin.stepLog ? JSON.stringify(fin.stepLog) : null}, step_log),
        manual_steps = COALESCE(${fin.manualSteps ? JSON.stringify(fin.manualSteps) : null}, manual_steps),
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
    storeCreditCents: r.store_credit_cents ?? null,
    oldDayofOrderId: r.old_dayof_order_id,
    newDayofOrderId: r.new_dayof_order_id,
    returnOrderIds: r.return_order_ids ?? null,
    spec: r.spec,
    plan: r.plan,
    stepLog: r.step_log,
    manualSteps: Array.isArray(r.manual_steps) ? r.manual_steps : null,
    acknowledged: r.acknowledged ?? null,
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
  return (await getOpenEditEvent(reservationIds)) !== null;
}

/**
 * The in-flight (resumable) edit attempt for any of these rows, or null.
 *
 * Unlike `hasOpenEditEvent` (an advisory plan-time warning), this returns the
 * ROW so the executor can hard-refuse a *different* edit while one is parked —
 * and still allow the legitimate resume of that same editId. Without the row
 * identity the executor cannot tell "resume my own crashed attempt" (safe,
 * replays the same idempotency keys) from "start a second, different edit on
 * top of one that already moved money" (double-refund).
 *
 * NOTE the 48h horizon is deliberate: it bounds how long an abandoned row can
 * block edits. Any state added to the resumable set here MUST also be added to
 * the executor's guard, or a parked attempt becomes invisible to it.
 */
export async function getOpenEditEvent(reservationIds: number[]): Promise<EditEventRow | null> {
  if (!isDbConfigured() || reservationIds.length === 0) return null;
  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      SELECT * FROM reservation_edit_events
      WHERE (anchor_reservation_id = ANY(${reservationIds}) OR leg_ids && ${reservationIds})
        AND state IN ('started', 'pending_payment')
        AND created_at > NOW() - INTERVAL '48 hours'
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows.length ? rowToEvent(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Cents already refunded against `paymentId` by edit attempts on this money
 * group — the day-of twin of refundAcrossTenders' stranded-refund netting.
 *
 * Without this, a FAILED attempt that got as far as refunding the day-of
 * payment double-refunds on retry: the new attempt bumps to a fresh
 * idempotency namespace, and refundTenderPartial clamps only to the PAYMENT's
 * un-refunded remainder (which is still large), so Square happily issues a
 * second refund for the same items. Netting exists for deposit tenders
 * (service.ts) but never covered day-of payments.
 *
 * FAILED/REJECTED refunds are ignored — that money never left.
 *
 * Only STRANDED refunds count — those recorded by attempts that never
 * completed (crashed / failed / this attempt's own resume) and that no
 * completed attempt has absorbed. A COMPLETED attempt's refund is settled
 * money from a DIFFERENT edit: netting it here made a second, unrelated
 * refund on the same reservation skip its day-of leg entirely ("already
 * refunded") while still paying the guest from the deposit — the same
 * absorbed/stranded split refundAcrossTenders has always applied on the
 * deposit leg. (2026-08-24 audit, R3.)
 */
export async function refundedCentsForPayment(
  reservationIds: number[],
  paymentId: string,
  fetchRefund: (
    refundId: string,
  ) => Promise<{ paymentId: string; amountCents: number; status: string }>,
): Promise<{ cents: number; refundIds: string[] }> {
  const events = await listEditEventsByAnchors(reservationIds);
  const absorbed = new Set(
    events.filter((e) => e.state === "completed").flatMap((e) => e.refundIds ?? []),
  );
  const ids = [
    ...new Set(events.filter((e) => e.state !== "completed").flatMap((e) => e.refundIds ?? [])),
  ].filter((id) => !absorbed.has(id));
  let cents = 0;
  const matched: string[] = [];
  for (const rid of ids) {
    let f: { paymentId: string; amountCents: number; status: string };
    try {
      f = await fetchRefund(rid);
    } catch {
      continue; // unreadable refund — treated as not-ours rather than blocking
    }
    if (f.status === "FAILED" || f.status === "REJECTED") continue;
    if (f.paymentId !== paymentId) continue;
    cents += f.amountCents;
    matched.push(rid);
  }
  return { cents, refundIds: matched };
}

/**
 * Store credit already issued against this money group by attempts that never
 * completed — the store-credit twin of refundedCentsForPayment. A failed
 * attempt that minted/loaded a card and then died on a later step still owns
 * that value; a retry must load only the remainder, never the full amount again.
 * Returns the stranded cents plus the card they sit on (the retry reuses it).
 */
export async function strandedStoreCredit(
  reservationIds: number[],
  excludeEditId?: string,
): Promise<{ cents: number; giftCardId: string | null; gan: string | null; editIds: string[] }> {
  const events = await listEditEventsByAnchors(reservationIds);
  let cents = 0;
  let giftCardId: string | null = null;
  let gan: string | null = null;
  const editIds: string[] = [];
  for (const e of events) {
    if (e.state === "completed") continue;
    if (excludeEditId && e.editId === excludeEditId) continue;
    if (!e.storeCreditCents || e.storeCreditCents <= 0) continue;
    cents += e.storeCreditCents;
    giftCardId = giftCardId ?? e.storeCreditGiftCardId;
    gan = gan ?? e.storeCreditGan;
    editIds.push(e.editId);
  }
  return { cents, giftCardId, gan, editIds };
}
