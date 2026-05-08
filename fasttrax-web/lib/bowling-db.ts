import { sql, isDbConfigured } from "@/lib/db";

/**
 * Bowling V2 — Neon data layer.
 *
 * Three tables:
 *   bowling_square_products   — product catalog mapping QAMF items → Square catalog
 *   bowling_reservations      — one row per confirmed booking (QAMF + Square IDs)
 *   bowling_reservation_lines — individual line items per reservation (for day-of order)
 *
 * Schema is auto-bootstrapped on first write via `ensureBowlingSchema()`.
 * All ALTER … ADD COLUMN IF NOT EXISTS statements are idempotent.
 *
 * ── BMI precision rule ────────────────────────────────────────────
 * bmi_bill_id is TEXT throughout. NEVER pass through Number() or
 * JSON.stringify() — BMI IDs exceed Number.MAX_SAFE_INTEGER.
 *
 * ── Product kinds ─────────────────────────────────────────────────
 *   'kbf'              — base KBF game options
 *   'open'             — base open bowling options
 *   'addon_shoe'       — shoe rental
 *   'addon_attraction' — laser tag / gel blaster / escape room (stub)
 *   'addon_food'       — F&B packages (stub)
 */

// ─────────────────────────────────────────────────────────────────
// Schema bootstrap
// ─────────────────────────────────────────────────────────────────

let schemaReady = false;

export async function ensureBowlingSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();

  // ── bowling_square_products ──────────────────────────────────────
  await q`
    CREATE TABLE IF NOT EXISTS bowling_square_products (
      id                       SERIAL  PRIMARY KEY,
      center_code              TEXT    NOT NULL,
      product_kind             TEXT    NOT NULL,
      label                    TEXT    NOT NULL,
      square_catalog_object_id TEXT    NOT NULL,
      price_cents              INTEGER NOT NULL DEFAULT 0,
      deposit_pct              INTEGER NOT NULL DEFAULT 100,
      sort_order               INTEGER NOT NULL DEFAULT 0,
      is_active                BOOLEAN NOT NULL DEFAULT TRUE,
      inserted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS bsp_upsert_key ON bowling_square_products(center_code, product_kind, square_catalog_object_id)`;
  await q`CREATE INDEX IF NOT EXISTS bsp_center_kind ON bowling_square_products(center_code, product_kind)`;
  await q`CREATE INDEX IF NOT EXISTS bsp_active ON bowling_square_products(center_code, product_kind) WHERE is_active = TRUE`;

  // qamf_web_offer_id: used by 'open' products to link a QAMF web offer to a
  // Square price. Added after initial create — idempotent.
  await q`ALTER TABLE bowling_square_products ADD COLUMN IF NOT EXISTS qamf_web_offer_id INTEGER`;
  await q`CREATE INDEX IF NOT EXISTS bsp_qamf_offer ON bowling_square_products(qamf_web_offer_id) WHERE qamf_web_offer_id IS NOT NULL`;

  // ── bowling_reservations ─────────────────────────────────────────
  await q`
    CREATE TABLE IF NOT EXISTS bowling_reservations (
      id                        SERIAL  PRIMARY KEY,
      center_code               TEXT    NOT NULL,
      product_kind              TEXT    NOT NULL,
      qamf_reservation_id       TEXT,
      bmi_bill_id               TEXT,
      bmi_reservation_number    TEXT,
      square_deposit_order_id   TEXT,
      square_deposit_payment_id TEXT,
      square_dayof_order_id     TEXT,
      deposit_cents             INTEGER NOT NULL DEFAULT 0,
      total_cents               INTEGER NOT NULL DEFAULT 0,
      status                    TEXT    NOT NULL DEFAULT 'confirmed',
      booked_at                 TIMESTAMPTZ NOT NULL,
      player_count              INTEGER,
      guest_name                TEXT,
      guest_email               TEXT,
      guest_phone               TEXT,
      notes                     TEXT,
      inserted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS br_qamf   ON bowling_reservations(qamf_reservation_id)     WHERE qamf_reservation_id IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS br_dep_sq ON bowling_reservations(square_deposit_order_id) WHERE square_deposit_order_id IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS br_day_sq ON bowling_reservations(square_dayof_order_id)   WHERE square_dayof_order_id IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS br_bmi    ON bowling_reservations(bmi_bill_id)             WHERE bmi_bill_id IS NOT NULL`;

  // ── bowling_reservation_lines ────────────────────────────────────
  await q`
    CREATE TABLE IF NOT EXISTS bowling_reservation_lines (
      id                SERIAL  PRIMARY KEY,
      reservation_id    INTEGER NOT NULL REFERENCES bowling_reservations(id),
      square_product_id INTEGER REFERENCES bowling_square_products(id),
      label             TEXT    NOT NULL,
      quantity          INTEGER NOT NULL DEFAULT 1,
      unit_price_cents  INTEGER NOT NULL DEFAULT 0,
      inserted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS brl_res ON bowling_reservation_lines(reservation_id)`;

  // ── bowling_reservation_players ──────────────────────────────────
  // One row per player slot per reservation.
  // Created at booking time: pre-filled with names + prefs for KBF,
  // placeholder rows for open bowling. Shoe sizes + bumpers collected
  // on the confirmation page and saved back here.
  await q`
    CREATE TABLE IF NOT EXISTS bowling_reservation_players (
      id              SERIAL  PRIMARY KEY,
      reservation_id  INTEGER NOT NULL REFERENCES bowling_reservations(id),
      slot            INTEGER NOT NULL,
      name            TEXT,
      shoe_size       TEXT,
      bumpers         BOOLEAN,
      kbf_pass_id     INTEGER,
      kbf_member_slot INTEGER,
      kbf_relation    TEXT CHECK (kbf_relation IN ('kid', 'family')),
      inserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (reservation_id, slot)
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS brp_res ON bowling_reservation_players(reservation_id)`;

  // ── Cancellation / refund columns (idempotent) ───────────────────
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS square_refund_id TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS refund_cents INTEGER NOT NULL DEFAULT 0`;

  schemaReady = true;
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type BowlingProductKind =
  | "kbf"
  | "open"
  | "addon_shoe"
  | "addon_attraction"
  | "addon_food";

export interface BowlingSquareProduct {
  id: number;
  centerCode: string;
  productKind: BowlingProductKind;
  label: string;
  squareCatalogObjectId: string;
  priceCents: number;
  /** Deposit charged at booking, expressed as percentage of priceCents (0–100). */
  depositPct: number;
  sortOrder: number;
  isActive: boolean;
  /**
   * For 'open' products: the QAMF web offer ID this product represents.
   * The wizard matches availability slots (by WebOffer.Id) to Neon products
   * using this field. Null for KBF and add-on products.
   */
  qamfWebOfferId?: number;
  insertedAt: string;
}

export interface ReservationLine {
  squareProductId?: number;
  label: string;
  quantity: number;
  unitPriceCents: number;
}

export interface BowlingReservationPlayer {
  id: number;
  reservationId: number;
  /** 1-based position within the reservation. */
  slot: number;
  /** Display name. Pre-filled for KBF, filled in by user for open bowling. */
  name: string | null;
  /** Shoe size label, e.g. "Kids 8" or "Adult 10". null = no shoes needed. */
  shoeSize: string | null;
  /** Bumper preference. null = not yet set. */
  bumpers: boolean | null;
  /** kbf_passes.id — set for KBF bowlers, null for open bowling. */
  kbfPassId: number | null;
  /** kbf_pass_members.slot for this member. */
  kbfMemberSlot: number | null;
  kbfRelation: "kid" | "family" | null;
  insertedAt: string;
  updatedAt: string;
}

export type PlayerInput = {
  slot: number;
  name?: string | null;
  shoeSize?: string | null;
  bumpers?: boolean | null;
  kbfPassId?: number | null;
  kbfMemberSlot?: number | null;
  kbfRelation?: "kid" | "family" | null;
};

export interface BowlingReservation {
  id: number;
  centerCode: string;
  productKind: "kbf" | "open";
  qamfReservationId?: string;
  /** BMI bill ID — always a raw string; never coerce to Number. */
  bmiBillId?: string;
  bmiReservationNumber?: string;
  squareDepositOrderId?: string;
  squareDepositPaymentId?: string;
  squareDayofOrderId?: string;
  depositCents: number;
  totalCents: number;
  status: "confirmed" | "arrived" | "completed" | "cancelled";
  bookedAt: string;
  playerCount?: number;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  notes?: string;
  /** ISO timestamp of cancellation. Null if not cancelled. */
  cancelledAt?: string;
  /** Square refund ID from /v2/refunds. Null if free booking or not yet refunded. */
  squareRefundId?: string;
  /** Actual amount refunded to the customer (cents). 0 if free booking. */
  refundCents: number;
  insertedAt: string;
}

// ─────────────────────────────────────────────────────────────────
// Product catalog helpers
// ─────────────────────────────────────────────────────────────────

function rowToProduct(row: Record<string, unknown>): BowlingSquareProduct {
  return {
    id: row.id as number,
    centerCode: row.center_code as string,
    productKind: row.product_kind as BowlingProductKind,
    label: row.label as string,
    squareCatalogObjectId: row.square_catalog_object_id as string,
    priceCents: row.price_cents as number,
    depositPct: row.deposit_pct as number,
    sortOrder: row.sort_order as number,
    isActive: row.is_active as boolean,
    qamfWebOfferId: row.qamf_web_offer_id != null ? (row.qamf_web_offer_id as number) : undefined,
    insertedAt: (row.inserted_at as Date).toISOString(),
  };
}

/**
 * Returns active products for a center, optionally filtered by kind.
 * Pass `includeInactive: true` to include inactive rows (admin use).
 */
export async function getBowlingSquareProducts(
  centerCode: string,
  kind?: BowlingProductKind,
  includeInactive = false,
): Promise<BowlingSquareProduct[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();

  let rows: Record<string, unknown>[];
  if (kind && includeInactive) {
    rows = await q`
      SELECT * FROM bowling_square_products
      WHERE center_code = ${centerCode} AND product_kind = ${kind}
      ORDER BY sort_order, id
    `;
  } else if (kind) {
    rows = await q`
      SELECT * FROM bowling_square_products
      WHERE center_code = ${centerCode} AND product_kind = ${kind} AND is_active = TRUE
      ORDER BY sort_order, id
    `;
  } else if (includeInactive) {
    rows = await q`
      SELECT * FROM bowling_square_products
      WHERE center_code = ${centerCode}
      ORDER BY product_kind, sort_order, id
    `;
  } else {
    rows = await q`
      SELECT * FROM bowling_square_products
      WHERE center_code = ${centerCode} AND is_active = TRUE
      ORDER BY product_kind, sort_order, id
    `;
  }

  return rows.map(rowToProduct);
}

/**
 * Find an active 'open' product for a center by QAMF web offer ID.
 * Used by the open bowling wizard to price a selected availability slot.
 */
export async function getBowlingOpenProductByOffer(
  centerCode: string,
  qamfWebOfferId: number,
): Promise<BowlingSquareProduct | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_square_products
    WHERE center_code = ${centerCode}
      AND product_kind = 'open'
      AND qamf_web_offer_id = ${qamfWebOfferId}
      AND is_active = TRUE
    LIMIT 1
  `;
  return rows.length ? rowToProduct(rows[0] as Record<string, unknown>) : null;
}

export async function getBowlingSquareProduct(id: number): Promise<BowlingSquareProduct | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`SELECT * FROM bowling_square_products WHERE id = ${id}`;
  return rows.length ? rowToProduct(rows[0] as Record<string, unknown>) : null;
}

/**
 * Upsert a product. Matches on (center_code, product_kind, square_catalog_object_id).
 * Used by the admin product endpoint to seed/update catalog entries.
 */
export async function upsertBowlingSquareProduct(
  p: Omit<BowlingSquareProduct, "id" | "insertedAt">,
): Promise<BowlingSquareProduct> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    INSERT INTO bowling_square_products
      (center_code, product_kind, label, square_catalog_object_id,
       price_cents, deposit_pct, sort_order, is_active, qamf_web_offer_id)
    VALUES
      (${p.centerCode}, ${p.productKind}, ${p.label}, ${p.squareCatalogObjectId},
       ${p.priceCents}, ${p.depositPct}, ${p.sortOrder}, ${p.isActive},
       ${p.qamfWebOfferId ?? null})
    ON CONFLICT (center_code, product_kind, square_catalog_object_id)
    DO UPDATE SET
      label              = EXCLUDED.label,
      price_cents        = EXCLUDED.price_cents,
      deposit_pct        = EXCLUDED.deposit_pct,
      sort_order         = EXCLUDED.sort_order,
      is_active          = EXCLUDED.is_active,
      qamf_web_offer_id  = EXCLUDED.qamf_web_offer_id
    RETURNING *
  `;
  return rowToProduct(rows[0] as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────
// Reservation helpers
// ─────────────────────────────────────────────────────────────────

function rowToReservation(row: Record<string, unknown>): BowlingReservation {
  return {
    id: row.id as number,
    centerCode: row.center_code as string,
    productKind: row.product_kind as "kbf" | "open",
    qamfReservationId: (row.qamf_reservation_id as string) ?? undefined,
    bmiBillId: (row.bmi_bill_id as string) ?? undefined,
    bmiReservationNumber: (row.bmi_reservation_number as string) ?? undefined,
    squareDepositOrderId: (row.square_deposit_order_id as string) ?? undefined,
    squareDepositPaymentId: (row.square_deposit_payment_id as string) ?? undefined,
    squareDayofOrderId: (row.square_dayof_order_id as string) ?? undefined,
    depositCents: row.deposit_cents as number,
    totalCents: row.total_cents as number,
    status: row.status as BowlingReservation["status"],
    bookedAt: (row.booked_at as Date).toISOString(),
    playerCount: (row.player_count as number) ?? undefined,
    guestName: (row.guest_name as string) ?? undefined,
    guestEmail: (row.guest_email as string) ?? undefined,
    guestPhone: (row.guest_phone as string) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    cancelledAt: row.cancelled_at
      ? (row.cancelled_at as Date).toISOString()
      : undefined,
    squareRefundId: (row.square_refund_id as string) ?? undefined,
    refundCents: (row.refund_cents as number) ?? 0,
    insertedAt: (row.inserted_at as Date).toISOString(),
  };
}

function rowToLine(row: Record<string, unknown>): ReservationLine & { id: number; reservationId: number } {
  return {
    id: row.id as number,
    reservationId: row.reservation_id as number,
    squareProductId: (row.square_product_id as number) ?? undefined,
    label: row.label as string,
    quantity: row.quantity as number,
    unitPriceCents: row.unit_price_cents as number,
  };
}

/**
 * Insert a reservation + its line items in a single transaction-like
 * sequence. Lines are inserted after the reservation row so we have
 * the reservation id to reference.
 *
 * NOTE: Neon's HTTP transport doesn't expose multi-statement
 * transactions directly. We accept the small risk of partial write
 * (reservation created but lines not) — the reservation row is still
 * valid; lines are additive analytics. If lines fail, the error is
 * logged but the reservation is returned.
 */
export async function insertBowlingReservation(
  r: Omit<BowlingReservation, "id" | "insertedAt" | "cancelledAt" | "squareRefundId" | "refundCents">,
  lines: ReservationLine[],
): Promise<BowlingReservation> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureBowlingSchema();
  const q = sql();

  const rows = await q`
    INSERT INTO bowling_reservations (
      center_code, product_kind,
      qamf_reservation_id, bmi_bill_id, bmi_reservation_number,
      square_deposit_order_id, square_deposit_payment_id, square_dayof_order_id,
      deposit_cents, total_cents, status,
      booked_at, player_count,
      guest_name, guest_email, guest_phone, notes
    ) VALUES (
      ${r.centerCode}, ${r.productKind},
      ${r.qamfReservationId ?? null}, ${r.bmiBillId ?? null}, ${r.bmiReservationNumber ?? null},
      ${r.squareDepositOrderId ?? null}, ${r.squareDepositPaymentId ?? null}, ${r.squareDayofOrderId ?? null},
      ${r.depositCents}, ${r.totalCents}, ${r.status},
      ${r.bookedAt}, ${r.playerCount ?? null},
      ${r.guestName ?? null}, ${r.guestEmail ?? null}, ${r.guestPhone ?? null}, ${r.notes ?? null}
    )
    RETURNING *
  `;

  const reservation = rowToReservation(rows[0] as Record<string, unknown>);

  // Insert line items — best-effort, don't fail the reservation on error
  if (lines.length > 0) {
    try {
      for (const line of lines) {
        await q`
          INSERT INTO bowling_reservation_lines
            (reservation_id, square_product_id, label, quantity, unit_price_cents)
          VALUES
            (${reservation.id}, ${line.squareProductId ?? null}, ${line.label}, ${line.quantity}, ${line.unitPriceCents})
        `;
      }
    } catch (err) {
      console.error("[bowling-db] failed to insert reservation lines:", err);
    }
  }

  return reservation;
}

export async function getBowlingReservation(
  id: number,
): Promise<(BowlingReservation & { lines: (ReservationLine & { id: number; reservationId: number })[] }) | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();

  const reservationRows = await q`SELECT * FROM bowling_reservations WHERE id = ${id}`;
  if (!reservationRows.length) return null;

  const reservation = rowToReservation(reservationRows[0] as Record<string, unknown>);
  const lineRows = await q`
    SELECT * FROM bowling_reservation_lines WHERE reservation_id = ${id} ORDER BY id
  `;

  return {
    ...reservation,
    lines: lineRows.map((r) => rowToLine(r as Record<string, unknown>)),
  };
}

export async function updateBowlingReservationStatus(
  id: number,
  status: BowlingReservation["status"],
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`UPDATE bowling_reservations SET status = ${status} WHERE id = ${id}`;
}

/**
 * Mark a reservation as cancelled and record refund details.
 * Called after Square refund + day-of order cancellation succeed.
 */
export async function updateBowlingReservationCancelled(
  id: number,
  { squareRefundId, refundCents }: { squareRefundId?: string; refundCents: number },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET
      status           = 'cancelled',
      cancelled_at     = NOW(),
      square_refund_id = ${squareRefundId ?? null},
      refund_cents     = ${refundCents}
    WHERE id = ${id}
  `;
}

/**
 * Update Square IDs on a reservation after the payment step completes.
 * Called by /api/bowling/v2/reserve after the Square orders are created.
 */
export async function updateBowlingReservationSquareIds(
  id: number,
  ids: {
    squareDepositOrderId?: string;
    squareDepositPaymentId?: string;
    squareDayofOrderId?: string;
  },
): Promise<void> {
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    UPDATE bowling_reservations SET
      square_deposit_order_id   = COALESCE(${ids.squareDepositOrderId ?? null}, square_deposit_order_id),
      square_deposit_payment_id = COALESCE(${ids.squareDepositPaymentId ?? null}, square_deposit_payment_id),
      square_dayof_order_id     = COALESCE(${ids.squareDayofOrderId ?? null}, square_dayof_order_id)
    WHERE id = ${id}
  `;
}

/**
 * Find the soonest future, non-cancelled KBF reservation for a guest email.
 * Used by the KBF wizard immediately after 2FA verify to detect duplicate
 * bookings — only one active KBF reservation is allowed at a time.
 */
export async function getFutureKbfReservationByEmail(
  email: string,
): Promise<(BowlingReservation & { lines: (ReservationLine & { id: number; reservationId: number })[] }) | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const normalizedEmail = email.toLowerCase().trim();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE product_kind = 'kbf'
      AND status NOT IN ('cancelled', 'completed')
      AND booked_at > NOW()
      AND LOWER(guest_email) = ${normalizedEmail}
    ORDER BY booked_at ASC
    LIMIT 1
  `;
  if (!rows.length) return null;
  const reservation = rowToReservation(rows[0] as Record<string, unknown>);
  const lineRows = await q`
    SELECT * FROM bowling_reservation_lines
    WHERE reservation_id = ${reservation.id}
    ORDER BY id
  `;
  return {
    ...reservation,
    lines: lineRows.map((r) => rowToLine(r as Record<string, unknown>)),
  };
}

/**
 * Update booked_at + qamf_reservation_id on an existing reservation after a
 * successful reschedule (old QAMF slot deleted, new one created).
 */
export async function updateReservationReschedule(
  id: number,
  bookedAt: string,
  qamfReservationId: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET booked_at = ${bookedAt}, qamf_reservation_id = ${qamfReservationId}
    WHERE id = ${id}
  `;
}

// ─────────────────────────────────────────────────────────────────
// Reservation player helpers
// ─────────────────────────────────────────────────────────────────

function rowToPlayer(row: Record<string, unknown>): BowlingReservationPlayer {
  return {
    id: row.id as number,
    reservationId: row.reservation_id as number,
    slot: row.slot as number,
    name: (row.name as string) ?? null,
    shoeSize: (row.shoe_size as string) ?? null,
    bumpers: row.bumpers != null ? (row.bumpers as boolean) : null,
    kbfPassId: row.kbf_pass_id != null ? (row.kbf_pass_id as number) : null,
    kbfMemberSlot: row.kbf_member_slot != null ? (row.kbf_member_slot as number) : null,
    kbfRelation: (row.kbf_relation as "kid" | "family") ?? null,
    insertedAt: (row.inserted_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Insert player rows for a reservation.
 * Called at booking time — once per player slot.
 * For KBF: names + KBF linkage pre-filled.
 * For open bowling: names are "Bowler N" placeholders.
 */
export async function insertReservationPlayers(
  reservationId: number,
  players: PlayerInput[],
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  for (const p of players) {
    await q`
      INSERT INTO bowling_reservation_players
        (reservation_id, slot, name, shoe_size, bumpers,
         kbf_pass_id, kbf_member_slot, kbf_relation)
      VALUES
        (${reservationId}, ${p.slot}, ${p.name ?? null}, ${p.shoeSize ?? null},
         ${p.bumpers ?? null}, ${p.kbfPassId ?? null},
         ${p.kbfMemberSlot ?? null}, ${p.kbfRelation ?? null})
      ON CONFLICT (reservation_id, slot) DO NOTHING
    `;
  }
}

/**
 * Fetch players for a reservation plus the number of shoe pairs purchased.
 * shoePairsAllowed = sum of addon_shoe line quantities.
 * The confirmation page uses this to validate that shoe sizes aren't
 * assigned to more bowlers than shoe pairs bought.
 */
export async function getReservationPlayersWithShoeAllowance(
  reservationId: number,
): Promise<{ players: BowlingReservationPlayer[]; shoePairsAllowed: number }> {
  if (!isDbConfigured()) return { players: [], shoePairsAllowed: 0 };
  await ensureBowlingSchema();
  const q = sql();

  const playerRows = await q`
    SELECT * FROM bowling_reservation_players
    WHERE reservation_id = ${reservationId}
    ORDER BY slot ASC
  `;

  // Sum qty of addon_shoe lines — join lines → products to check product_kind
  const shoeRows = await q`
    SELECT COALESCE(SUM(brl.quantity), 0) AS shoe_qty
    FROM bowling_reservation_lines brl
    JOIN bowling_square_products bsp ON bsp.id = brl.square_product_id
    WHERE brl.reservation_id = ${reservationId}
      AND bsp.product_kind = 'addon_shoe'
  `;
  const shoePairsAllowed = Number((shoeRows[0] as Record<string, unknown>).shoe_qty ?? 0);

  return {
    players: playerRows.map((r) => rowToPlayer(r as Record<string, unknown>)),
    shoePairsAllowed,
  };
}

/**
 * Upsert a single player's shoe size and bumpers preference.
 * Called by the PATCH players API after the confirmation-page form is saved.
 */
export async function upsertReservationPlayer(
  reservationId: number,
  slot: number,
  update: { name?: string | null; shoeSize?: string | null; bumpers?: boolean | null },
): Promise<BowlingReservationPlayer | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    UPDATE bowling_reservation_players
    SET
      name       = CASE WHEN ${update.name !== undefined} THEN ${update.name ?? null} ELSE name END,
      shoe_size  = CASE WHEN ${update.shoeSize !== undefined} THEN ${update.shoeSize ?? null} ELSE shoe_size END,
      bumpers    = CASE WHEN ${update.bumpers !== undefined} THEN ${update.bumpers ?? null} ELSE bumpers END,
      updated_at = NOW()
    WHERE reservation_id = ${reservationId} AND slot = ${slot}
    RETURNING *
  `;
  return rows.length ? rowToPlayer(rows[0] as Record<string, unknown>) : null;
}

// ─────────────────────────────────────────────────────────────────
// Utility: compute deposit amount from a list of products + quantities
// ─────────────────────────────────────────────────────────────────

export function computeBowlingTotals(
  items: Array<{ product: BowlingSquareProduct; quantity: number }>,
): { depositCents: number; totalCents: number } {
  let totalCents = 0;
  let depositCents = 0;
  for (const { product, quantity } of items) {
    const lineTotal = product.priceCents * quantity;
    totalCents += lineTotal;
    depositCents += Math.round(lineTotal * (product.depositPct / 100));
  }
  return { depositCents, totalCents };
}
