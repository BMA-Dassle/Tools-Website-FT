/**
 * Card-vault data layer — `reservation_saved_cards` + the pure due-for-disable
 * predicate the sweep runs after loading candidates.
 *
 * Mirrors the lazy CREATE TABLE IF NOT EXISTS + ensureSchema-memo pattern of
 * `~/features/reservations-admin/audit.ts` (no migrations framework in this
 * repo). Raw SQL via @neondatabase/serverless — no ORM (BMI precision rule).
 *
 * No `delete_after` column on purpose: due-ness is COMPUTED by the sweep from
 * live reservation state (`isDueForDisable`), which handles combo legs
 * completing at different times, cancellations, and reschedules automatically.
 */
import { neon } from "@neondatabase/serverless";
import type { ConsentSource, DisableGroupLeg, SavedCardRow } from "./types";

const isDbConfigured = (): boolean => !!process.env.DATABASE_URL;
const sql = () => neon(process.env.DATABASE_URL!);

/** Terminal reservation statuses — MUST match what the status-close cron
 *  writes (`closePastReservationStatuses` in lib/bowling-db.ts flips rows to
 *  'completed' / 'no_show'; cancellation writes 'cancelled'). */
export const TERMINAL_STATUSES = ["completed", "cancelled", "no_show"] as const;

/** Auto-disable delay after the whole money group is terminal. */
export const DISABLE_AFTER_MS = 72 * 60 * 60 * 1000;

/** Capture retries are capped (sweep phase 1). */
export const MAX_CAPTURE_ATTEMPTS = 5;

/** Disable retries are capped (sweep phase 2). */
export const MAX_DISABLE_ATTEMPTS = 8;

let schemaReady = false;
const ensureSchema = async (): Promise<void> => {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS reservation_saved_cards (
      id BIGSERIAL PRIMARY KEY,
      square_customer_id TEXT NOT NULL,
      square_card_id TEXT,
      card_brand TEXT,
      card_last4 TEXT,
      card_exp_month INTEGER,
      card_exp_year INTEGER,
      fingerprint TEXT,
      source_reservation_id INTEGER,
      source_deposit_order_id TEXT,
      source_payment_id TEXT NOT NULL UNIQUE,
      we_added BOOLEAN NOT NULL DEFAULT FALSE,
      permanent_consent BOOLEAN NOT NULL DEFAULT FALSE,
      consent_source TEXT,
      capture_attempts INTEGER NOT NULL DEFAULT 0,
      capture_last_error TEXT,
      disabled_at TIMESTAMPTZ,
      disable_attempts INTEGER NOT NULL DEFAULT 0,
      disable_last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS rsc_customer ON reservation_saved_cards (square_customer_id)
  `;
  await q`
    CREATE INDEX IF NOT EXISTS rsc_deposit_order
      ON reservation_saved_cards (source_deposit_order_id)
  `;
  schemaReady = true;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const rowToCard = (r: any): SavedCardRow => ({
  id: Number(r.id),
  squareCustomerId: r.square_customer_id,
  squareCardId: r.square_card_id ?? null,
  cardBrand: r.card_brand ?? null,
  cardLast4: r.card_last4 ?? null,
  cardExpMonth: r.card_exp_month ?? null,
  cardExpYear: r.card_exp_year ?? null,
  fingerprint: r.fingerprint ?? null,
  sourceReservationId: r.source_reservation_id ?? null,
  sourceDepositOrderId: r.source_deposit_order_id ?? null,
  sourcePaymentId: r.source_payment_id,
  weAdded: !!r.we_added,
  permanentConsent: !!r.permanent_consent,
  consentSource: (r.consent_source as ConsentSource | null) ?? null,
  captureAttempts: r.capture_attempts ?? 0,
  captureLastError: r.capture_last_error ?? null,
  disabledAt: r.disabled_at ? new Date(r.disabled_at).toISOString() : null,
  disableAttempts: r.disable_attempts ?? 0,
  disableLastError: r.disable_last_error ?? null,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : "",
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : "",
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface UpsertCapturedCardParams {
  squareCustomerId: string;
  /** NULL = pending anchor (persist-first: written BEFORE CreateCard so a
   *  crash mid-capture leaves a durable row the sweep retries). */
  squareCardId: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  cardExpMonth?: number | null;
  cardExpYear?: number | null;
  fingerprint?: string | null;
  sourceReservationId: number | null;
  sourceDepositOrderId: string | null;
  sourcePaymentId: string;
  weAdded: boolean;
  permanentConsent: boolean;
  consentSource: ConsentSource | null;
}

/**
 * Insert-or-update keyed on source_payment_id. A retry never clears a
 * previously captured card id (COALESCE) and permanent consent is sticky —
 * it can be granted later but never silently revoked by a replay.
 */
export const upsertCapturedCard = async (p: UpsertCapturedCardParams): Promise<void> => {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO reservation_saved_cards (
      square_customer_id, square_card_id, card_brand, card_last4,
      card_exp_month, card_exp_year, fingerprint,
      source_reservation_id, source_deposit_order_id, source_payment_id,
      we_added, permanent_consent, consent_source
    ) VALUES (
      ${p.squareCustomerId}, ${p.squareCardId}, ${p.cardBrand ?? null}, ${p.cardLast4 ?? null},
      ${p.cardExpMonth ?? null}, ${p.cardExpYear ?? null}, ${p.fingerprint ?? null},
      ${p.sourceReservationId}, ${p.sourceDepositOrderId}, ${p.sourcePaymentId},
      ${p.weAdded}, ${p.permanentConsent}, ${p.consentSource}
    )
    ON CONFLICT (source_payment_id) DO UPDATE SET
      square_card_id = COALESCE(EXCLUDED.square_card_id, reservation_saved_cards.square_card_id),
      card_brand = COALESCE(EXCLUDED.card_brand, reservation_saved_cards.card_brand),
      card_last4 = COALESCE(EXCLUDED.card_last4, reservation_saved_cards.card_last4),
      card_exp_month = COALESCE(EXCLUDED.card_exp_month, reservation_saved_cards.card_exp_month),
      card_exp_year = COALESCE(EXCLUDED.card_exp_year, reservation_saved_cards.card_exp_year),
      fingerprint = COALESCE(EXCLUDED.fingerprint, reservation_saved_cards.fingerprint),
      we_added = EXCLUDED.we_added,
      permanent_consent = reservation_saved_cards.permanent_consent OR EXCLUDED.permanent_consent,
      consent_source = COALESCE(EXCLUDED.consent_source, reservation_saved_cards.consent_source),
      capture_last_error = NULL,
      updated_at = NOW()
  `;
};

export interface RecordCaptureFailureParams {
  squareCustomerId: string;
  sourceReservationId: number | null;
  sourceDepositOrderId: string | null;
  sourcePaymentId: string;
  permanentConsent: boolean;
  consentSource: ConsentSource | null;
  error: string;
}

/** Durable failure anchor — the sweep retries pending rows (≤5 attempts). */
export const recordCaptureFailure = async (p: RecordCaptureFailureParams): Promise<void> => {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO reservation_saved_cards (
      square_customer_id, source_reservation_id, source_deposit_order_id, source_payment_id,
      we_added, permanent_consent, consent_source, capture_attempts, capture_last_error
    ) VALUES (
      ${p.squareCustomerId}, ${p.sourceReservationId}, ${p.sourceDepositOrderId},
      ${p.sourcePaymentId}, TRUE, ${p.permanentConsent}, ${p.consentSource}, 1,
      ${p.error.slice(0, 500)}
    )
    ON CONFLICT (source_payment_id) DO UPDATE SET
      capture_attempts = reservation_saved_cards.capture_attempts + 1,
      capture_last_error = ${p.error.slice(0, 500)},
      updated_at = NOW()
  `;
};

/** Pending captures (CreateCard not yet succeeded), oldest-touched first. */
export const listPendingCaptures = async (limit: number): Promise<SavedCardRow[]> => {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM reservation_saved_cards
    WHERE square_card_id IS NULL
      AND disabled_at IS NULL
      AND capture_attempts < ${MAX_CAPTURE_ATTEMPTS}
    ORDER BY updated_at ASC
    LIMIT ${limit}
  `;
  return rows.map(rowToCard);
};

/**
 * SQL shortlist of disable candidates. Row-local rules live here (we_added,
 * no consent, attempts < 8, older than 72h — a group can never be terminal
 * for 72h before the row is 72h old — and no OTHER live permanent row on the
 * same Square card id). The reservation-state rules (whole money group
 * terminal >72h, no other live reservation for the customer) are decided by
 * `isDueForDisable` after the sweep loads the live rows.
 */
export const listDueForDisable = async (limit: number): Promise<SavedCardRow[]> => {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM reservation_saved_cards c
    WHERE c.we_added
      AND NOT c.permanent_consent
      AND c.disabled_at IS NULL
      AND c.square_card_id IS NOT NULL
      AND c.disable_attempts < ${MAX_DISABLE_ATTEMPTS}
      AND c.created_at < NOW() - INTERVAL '72 hours'
      AND NOT EXISTS (
        SELECT 1 FROM reservation_saved_cards p
        WHERE p.square_card_id = c.square_card_id
          AND p.id <> c.id
          AND p.permanent_consent
          AND p.disabled_at IS NULL
      )
    ORDER BY c.created_at ASC
    LIMIT ${limit}
  `;
  return rows.map(rowToCard);
};

export const markDisabled = async (id: number): Promise<void> => {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE reservation_saved_cards
    SET disabled_at = NOW(), disable_last_error = NULL, updated_at = NOW()
    WHERE id = ${id}
  `;
};

export const recordDisableFailure = async (id: number, error: string): Promise<void> => {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE reservation_saved_cards
    SET disable_attempts = disable_attempts + 1,
        disable_last_error = ${error.slice(0, 500)},
        updated_at = NOW()
    WHERE id = ${id}
  `;
};

/** Newest usable vault row for a customer (captured + not disabled). */
export const getCardForCustomer = async (customerId: string): Promise<SavedCardRow | null> => {
  if (!isDbConfigured() || !customerId) return null;
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM reservation_saved_cards
    WHERE square_customer_id = ${customerId}
      AND square_card_id IS NOT NULL
      AND disabled_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows.length ? rowToCard(rows[0]) : null;
};

/**
 * Vault row for a reservation's money group — matched by the deposit order id
 * (the group key), falling back to the customer's newest row (covers legacy
 * rows and admin-granted cards). Disabled rows ARE returned so the Payments
 * tab can show "removed {date}".
 */
export const getCardStatusForReservation = async (
  depositOrderId: string | null | undefined,
  customerId: string | null | undefined,
): Promise<SavedCardRow | null> => {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  if (depositOrderId) {
    const rows = await q`
      SELECT * FROM reservation_saved_cards
      WHERE source_deposit_order_id = ${depositOrderId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (rows.length) return rowToCard(rows[0]);
  }
  if (customerId) {
    const rows = await q`
      SELECT * FROM reservation_saved_cards
      WHERE square_customer_id = ${customerId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (rows.length) return rowToCard(rows[0]);
  }
  return null;
};

/** Admin "mark permanent": the row is never auto-disabled afterwards. */
export const grantPermanentConsent = async (id: number): Promise<void> => {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE reservation_saved_cards
    SET permanent_consent = TRUE, consent_source = 'admin', updated_at = NOW()
    WHERE id = ${id}
  `;
};

/**
 * Live (non-terminal) reservations for a customer, excluding the given ids
 * (the vault row's own money group). >0 defers the disable — an edit on the
 * other reservation may still need the card.
 */
export const countLiveReservationsForCustomer = async (
  customerId: string,
  excludeIds: number[],
): Promise<number> => {
  if (!isDbConfigured() || !customerId) return 0;
  await ensureSchema();
  const q = sql();
  const rows = await q`
    SELECT COUNT(*)::int AS n FROM bowling_reservations
    WHERE square_customer_id = ${customerId}
      AND status NOT IN ('completed', 'cancelled', 'no_show')
      AND NOT (id = ANY(${excludeIds}))
  `;
  return rows.length ? Number((rows[0] as { n: number }).n) : 0;
};

// ── Pure due-for-disable predicate ──────────────────────────────────────────

const TERMINAL_SET = new Set<string>(TERMINAL_STATUSES);

/** Best event-time reference for a leg from its bookingMetadata (race heat
 *  starts / attraction slot starts — booked_at is the BOOKING time for those
 *  anchors, not the visit). Returns the latest ms, or null when none. */
const latestMetadataEventMs = (leg: DisableGroupLeg): number | null => {
  const meta = leg.bookingMetadata;
  if (!meta) return null;
  const times: number[] = [];
  const heats = meta.heats;
  if (Array.isArray(heats)) {
    for (const h of heats) {
      const heatId = (h as { heatId?: unknown })?.heatId;
      if (typeof heatId === "string") {
        const ms = Date.parse(heatId);
        if (!Number.isNaN(ms)) times.push(ms);
      }
    }
  }
  const attractions = meta.attractions;
  if (Array.isArray(attractions)) {
    for (const a of attractions) {
      const slot = (a as { slot?: unknown })?.slot;
      if (typeof slot === "string") {
        const ms = Date.parse(slot);
        if (!Number.isNaN(ms)) times.push(ms);
      }
    }
  }
  return times.length ? Math.max(...times) : null;
};

/**
 * When THIS leg went terminal (approximation from the columns we have):
 *  - cancelled → cancelled_at (a cancelled booking's future visit never
 *    happens, so the 72h clock runs from the cancellation);
 *  - completed / no_show → the latest of booked_at and any metadata event
 *    time (visit start — the true close timestamp isn't exposed; the 72h
 *    buffer absorbs the session length).
 */
export const legTerminalMs = (leg: DisableGroupLeg): number => {
  if (leg.status === "cancelled" && leg.cancelledAt) {
    const ms = Date.parse(leg.cancelledAt);
    if (!Number.isNaN(ms)) return ms;
  }
  const booked = Date.parse(leg.bookedAt);
  const bookedMs = Number.isNaN(booked) ? 0 : booked;
  const eventMs = latestMetadataEventMs(leg);
  return eventMs != null ? Math.max(bookedMs, eventMs) : bookedMs;
};

/**
 * PURE disable decision — the sweep loads the shortlist + live reservation
 * rows, then asks this. True only when ALL hold (plan §7 "Deletion"):
 *  1. the row is ours to remove: we_added, no permanent consent, not already
 *     disabled, a card id exists, attempts < 8;
 *  2. EVERY leg of the source money group is terminal
 *     (completed | cancelled | no_show) — a mixed combo (one leg done, one
 *     upcoming) is NOT due;
 *  3. the latest terminal reference across the group is > 72h ago;
 *  4. the customer has NO other live reservation (its edit may still need
 *     the card).
 * (The "no other permanent row on the same card id" rule is enforced by the
 * `listDueForDisable` SQL shortlist — it's a table-local fact.)
 */
export const isDueForDisable = (
  card: SavedCardRow,
  groupReservations: DisableGroupLeg[],
  customerLiveCount: number,
  now: Date,
): boolean => {
  if (!card.weAdded) return false;
  if (card.permanentConsent) return false;
  if (card.disabledAt) return false;
  if (!card.squareCardId) return false;
  if (card.disableAttempts >= MAX_DISABLE_ATTEMPTS) return false;

  if (groupReservations.length === 0) return false;
  if (!groupReservations.every((leg) => TERMINAL_SET.has(leg.status))) return false;

  // Strictly MORE than 72h ago ("terminal < now − 72h") — exactly 72h waits.
  const latestTerminal = Math.max(...groupReservations.map(legTerminalMs));
  if (now.getTime() - latestTerminal <= DISABLE_AFTER_MS) return false;

  if (customerLiveCount > 0) return false;

  return true;
};
