import { type NeonQueryFunction } from "@neondatabase/serverless";
import { sql, isDbConfigured } from "@/lib/db";

/**
 * Bowling V2 — Neon data layer.
 *
 * Tables:
 *   bowling_square_products      — product catalog: Square catalog IDs + prices
 *   bowling_experiences          — our canonical experience catalog ('Fun 4 All VIP', etc.)
 *   bowling_experience_items     — Square products bundled into an experience (the combo)
 *   bowling_experience_offers    — per-center QAMF web offer ID for each experience
 *   bowling_reservations         — one row per confirmed booking (QAMF + Square IDs)
 *   bowling_reservation_lines    — individual line items per reservation (for day-of order)
 *   bowling_reservation_players  — per-player slot rows (shoe size, bumpers, KBF linkage)
 *
 * Schema is auto-bootstrapped on first write via `ensureBowlingSchema()`.
 * All ALTER … ADD COLUMN IF NOT EXISTS statements are idempotent.
 *
 * ── BMI precision rule ────────────────────────────────────────────
 * bmi_bill_id is TEXT throughout. NEVER pass through Number() or
 * JSON.stringify() — BMI IDs exceed Number.MAX_SAFE_INTEGER.
 *
 * ── Product kinds ─────────────────────────────────────────────────
 *   'addon_shoe'       — shoe rental (per person, optional)
 *   'addon_attraction' — laser tag / gel blaster / escape room (stub)
 *   'addon_food'       — F&B packages (stub)
 *   (base bowling items live as experience_items, not standalone products)
 *
 * ── Experience kinds ──────────────────────────────────────────────
 *   'kbf'    — Kids Bowl Free (free base, may have shoe add-ons)
 *   'open'   — Open / Fun 4 All bowling (paid base)
 *   'hourly' — Hourly lane rental (paid base)
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

  // qamf_web_offer_id: legacy column — superseded by bowling_experience_offers.
  // Kept for backward compatibility; no longer written to for new rows.
  await q`ALTER TABLE bowling_square_products ADD COLUMN IF NOT EXISTS qamf_web_offer_id INTEGER`;

  // ── bowling_experiences ──────────────────────────────────────────
  // Our canonical experience catalog, independent of QAMF or Square internals.
  // kind values: 'kbf' | 'open' | 'hourly'
  await q`
    CREATE TABLE IF NOT EXISTS bowling_experiences (
      id          SERIAL  PRIMARY KEY,
      slug        TEXT    NOT NULL UNIQUE,   -- 'fun-4-all-vip', 'kbf-regular', etc.
      label       TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      is_vip      BOOLEAN NOT NULL DEFAULT FALSE,
      description TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS be_kind ON bowling_experiences(kind) WHERE is_active = TRUE`;

  // ── bowling_experience_items ─────────────────────────────────────
  // Square products that are auto-included (bundled) when this experience is selected.
  // Distinct from optional add-ons (shoes, attractions) which are wizard steps.
  await q`
    CREATE TABLE IF NOT EXISTS bowling_experience_items (
      id                        SERIAL  PRIMARY KEY,
      experience_id             INTEGER NOT NULL REFERENCES bowling_experiences(id),
      square_product_id         INTEGER REFERENCES bowling_square_products(id),
      square_catalog_object_id  TEXT,   -- used for center-agnostic item lookup
      quantity                  INTEGER NOT NULL DEFAULT 1,
      label_override            TEXT,   -- null → use product.label
      sort_order                INTEGER NOT NULL DEFAULT 0,
      center_code               TEXT    -- null = all centers; value = center-specific only
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS bei_exp ON bowling_experience_items(experience_id)`;
  await q`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS square_catalog_object_id TEXT`;
  await q`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS center_code TEXT`;

  // ── bowling_experience_offers ────────────────────────────────────
  // Maps an experience to the QAMF web offer ID at a specific center.
  // Same experience → different offer IDs per center.
  await q`
    CREATE TABLE IF NOT EXISTS bowling_experience_offers (
      id                  SERIAL  PRIMARY KEY,
      experience_id       INTEGER NOT NULL REFERENCES bowling_experiences(id),
      center_code         TEXT    NOT NULL,
      qamf_web_offer_id   INTEGER NOT NULL,
      qamf_option_type    TEXT,          -- 'Game' | 'Time' | 'Unlimited'
      qamf_option_id      INTEGER,
      is_active           BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE (center_code, qamf_web_offer_id)
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS beo_center ON bowling_experience_offers(center_code, qamf_web_offer_id)`;
  await q`CREATE INDEX IF NOT EXISTS beo_exp    ON bowling_experience_offers(experience_id)`;

  // center_code on items: NULL = all centers, value = center-specific (e.g. FM-only Chips & Salsa)
  await q`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS center_code TEXT`;

  // ── bowling_experience_duration_options ──────────────────────────
  // For Time-based QAMF offers with multiple durations (e.g. 1.5hr / 2hr).
  // square_multiplier: quantity multiplier applied to base experience items.
  //   1.5hr → multiplier 1  (charge base items × 1)
  //   2hr   → multiplier 2  (charge base items × 2, i.e. two 1.5hr units)
  await q`
    CREATE TABLE IF NOT EXISTS bowling_experience_duration_options (
      id                SERIAL  PRIMARY KEY,
      experience_id     INTEGER NOT NULL REFERENCES bowling_experiences(id),
      center_code       TEXT    NOT NULL,
      qamf_option_id    INTEGER NOT NULL,
      duration_minutes  INTEGER NOT NULL,
      label             TEXT    NOT NULL,    -- "1.5 Hours", "2 Hours"
      square_multiplier INTEGER NOT NULL DEFAULT 1,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      UNIQUE (experience_id, center_code, qamf_option_id)
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS bedo_exp ON bowling_experience_duration_options(experience_id, center_code)`;

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

  // ── eGift card columns (idempotent) ──────────────────────────────
  // The gift card stores the exact deposit amount, enabling accurate
  // refunds without the tax-rounding mismatch of a deposit-order approach.
  // Balance is loaded at booking time; deactivated on cancellation after refund.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS square_gift_card_id TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS square_gift_card_gan TEXT`;

  schemaReady = true;
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type BowlingProductKind =
  | "kbf"             // base KBF lane item (referenced by experience_items; free)
  | "open"            // base open bowling lane item (referenced by experience_items)
  | "hourly"          // hourly lane item (referenced by experience_items)
  | "addon_shoe"      // shoe rental (optional per-person add-on)
  | "addon_attraction" // laser tag / gel blaster / escape room (stub)
  | "addon_food";      // F&B packages (stub)

export type BowlingExperienceKind = "kbf" | "open" | "hourly";

// ── Experience types ───────────────────────────────────────────────────────

export interface BowlingExperience {
  id: number;
  slug: string;
  label: string;
  kind: BowlingExperienceKind;
  isVip: boolean;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  insertedAt: string;
}

/**
 * One Square product bundled into an experience (the combo).
 * priceCents / depositPct / squareCatalogObjectId are denormalized from
 * bowling_square_products for convenient consumption by the wizard.
 */
export interface BowlingExperienceItem {
  id: number;
  experienceId: number;
  squareProductId: number;
  label: string;                  // label_override ?? product.label
  priceCents: number;
  depositPct: number;
  squareCatalogObjectId: string;
  quantity: number;
  sortOrder: number;
}

export interface BowlingExperienceOffer {
  id: number;
  experienceId: number;
  centerCode: string;
  qamfWebOfferId: number;
  qamfOptionType: string | null;  // 'Game' | 'Time' | 'Unlimited'
  qamfOptionId: number | null;
  isActive: boolean;
}

export interface BowlingExperienceDurationOption {
  id: number;
  experienceId: number;
  centerCode: string;
  qamfOptionId: number;
  durationMinutes: number;
  label: string;            // "1.5 Hours", "2 Hours"
  squareMultiplier: number; // quantity multiplier on base experience items
  sortOrder: number;
}

/** Experience with center-specific QAMF offer resolved + bundled items pre-joined. */
export interface BowlingExperienceWithDetails extends BowlingExperience {
  qamfWebOfferId: number;
  qamfOptionType: string | null;
  qamfOptionId: number | null;
  items: BowlingExperienceItem[];
  /** Present for Time-based offers (kind='hourly'). Empty for Game/Unlimited. */
  durationOptions: BowlingExperienceDurationOption[];
}

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
   * Legacy — QAMF web offer ID previously stored directly on products.
   * Superseded by bowling_experience_offers. Present on old rows only.
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
  /** Square payment ID for the deposit charge. */
  squareDepositPaymentId?: string;
  /** Square day-of order ID — left open for staff to redeem at center. */
  squareDayofOrderId?: string;
  /**
   * Square eGift card ID — holds the deposit amount as its balance.
   * Used to get the exact refund amount on cancellation (avoids tax-rounding
   * mismatch). Null for free ($0) bookings.
   */
  squareGiftCardId?: string;
  /** Square eGift card GAN (Gift Account Number) — human-readable card number. */
  squareGiftCardGan?: string;
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
    squareDepositPaymentId: (row.square_deposit_payment_id as string) ?? undefined,
    squareDayofOrderId: (row.square_dayof_order_id as string) ?? undefined,
    squareGiftCardId: (row.square_gift_card_id as string) ?? undefined,
    squareGiftCardGan: (row.square_gift_card_gan as string) ?? undefined,
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
      square_deposit_payment_id, square_dayof_order_id,
      square_gift_card_id, square_gift_card_gan,
      deposit_cents, total_cents, status,
      booked_at, player_count,
      guest_name, guest_email, guest_phone, notes
    ) VALUES (
      ${r.centerCode}, ${r.productKind},
      ${r.qamfReservationId ?? null}, ${r.bmiBillId ?? null}, ${r.bmiReservationNumber ?? null},
      ${r.squareDepositPaymentId ?? null}, ${r.squareDayofOrderId ?? null},
      ${r.squareGiftCardId ?? null}, ${r.squareGiftCardGan ?? null},
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
    squareDepositPaymentId?: string;
    squareDayofOrderId?: string;
    squareGiftCardId?: string;
    squareGiftCardGan?: string;
  },
): Promise<void> {
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    UPDATE bowling_reservations SET
      square_deposit_payment_id = COALESCE(${ids.squareDepositPaymentId ?? null}, square_deposit_payment_id),
      square_dayof_order_id     = COALESCE(${ids.squareDayofOrderId ?? null}, square_dayof_order_id),
      square_gift_card_id       = COALESCE(${ids.squareGiftCardId ?? null}, square_gift_card_id),
      square_gift_card_gan      = COALESCE(${ids.squareGiftCardGan ?? null}, square_gift_card_gan)
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
// Experience catalog helpers
// ─────────────────────────────────────────────────────────────────

function rowToExperience(row: Record<string, unknown>): BowlingExperience {
  return {
    id: row.id as number,
    slug: row.slug as string,
    label: row.label as string,
    kind: row.kind as BowlingExperienceKind,
    isVip: row.is_vip as boolean,
    description: (row.description as string) ?? null,
    sortOrder: row.sort_order as number,
    isActive: row.is_active as boolean,
    insertedAt: (row.inserted_at as Date).toISOString(),
  };
}

function rowToExperienceWithDetails(row: Record<string, unknown>): BowlingExperienceWithDetails {
  return {
    ...rowToExperience(row),
    qamfWebOfferId: row.qamf_web_offer_id as number,
    qamfOptionType: (row.qamf_option_type as string) ?? null,
    qamfOptionId: row.qamf_option_id != null ? (row.qamf_option_id as number) : null,
    items: (row.items as BowlingExperienceItem[]) ?? [],
    durationOptions: [],
  };
}

/**
 * Fetch bundled items for an array of experience IDs.
 * When centerCode is provided, filters to items that apply to that center
 * (center_code IS NULL = all centers, or matches exactly).
 * When omitted (admin), returns all items regardless of center.
 */
async function fetchExperienceItems(
  q: NeonQueryFunction<false, false>,
  experienceIds: number[],
  centerCode?: string,
): Promise<Map<number, BowlingExperienceItem[]>> {
  if (!experienceIds.length) return new Map();
  // Note: no is_active filter on bsp — experience items are bundled products
  // whose availability is controlled by the experience itself, not the product flag.
  const itemRows = centerCode
    ? await q`
        SELECT
          bei.id, bei.experience_id, bei.square_product_id,
          COALESCE(bei.label_override, bsp.label) AS label,
          bsp.price_cents, bsp.deposit_pct, bsp.square_catalog_object_id,
          bei.quantity, bei.sort_order
        FROM bowling_experience_items bei
        JOIN bowling_square_products bsp
          ON bsp.square_catalog_object_id = bei.square_catalog_object_id
         AND bsp.center_code = ${centerCode}
        WHERE bei.experience_id = ANY(${experienceIds})
          AND (bei.center_code IS NULL OR bei.center_code = ${centerCode})
        ORDER BY bei.experience_id, bei.sort_order
      `
    : await q`
        SELECT
          bei.id, bei.experience_id, bei.square_product_id,
          COALESCE(bei.label_override, bsp.label) AS label,
          bsp.price_cents, bsp.deposit_pct, bsp.square_catalog_object_id,
          bei.quantity, bei.sort_order
        FROM bowling_experience_items bei
        JOIN bowling_square_products bsp ON bsp.id = bei.square_product_id
        WHERE bei.experience_id = ANY(${experienceIds})
        ORDER BY bei.experience_id, bei.sort_order
      `;
  const map = new Map<number, BowlingExperienceItem[]>();
  for (const row of itemRows) {
    const r = row as Record<string, unknown>;
    const eid = r.experience_id as number;
    const item: BowlingExperienceItem = {
      id: r.id as number,
      experienceId: eid,
      squareProductId: r.square_product_id as number,
      label: r.label as string,
      priceCents: r.price_cents as number,
      depositPct: r.deposit_pct as number,
      squareCatalogObjectId: r.square_catalog_object_id as string,
      quantity: r.quantity as number,
      sortOrder: r.sort_order as number,
    };
    if (!map.has(eid)) map.set(eid, []);
    map.get(eid)!.push(item);
  }
  return map;
}

/** Fetch duration options for an array of experience IDs at a specific center. */
async function fetchDurationOptions(
  q: NeonQueryFunction<false, false>,
  experienceIds: number[],
  centerCode: string,
): Promise<Map<number, BowlingExperienceDurationOption[]>> {
  if (!experienceIds.length) return new Map();
  const rows = await q`
    SELECT * FROM bowling_experience_duration_options
    WHERE experience_id = ANY(${experienceIds})
      AND center_code = ${centerCode}
    ORDER BY experience_id, sort_order
  `;
  const map = new Map<number, BowlingExperienceDurationOption[]>();
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const eid = r.experience_id as number;
    const opt: BowlingExperienceDurationOption = {
      id: r.id as number,
      experienceId: eid,
      centerCode: r.center_code as string,
      qamfOptionId: r.qamf_option_id as number,
      durationMinutes: r.duration_minutes as number,
      label: r.label as string,
      squareMultiplier: r.square_multiplier as number,
      sortOrder: r.sort_order as number,
    };
    if (!map.has(eid)) map.set(eid, []);
    map.get(eid)!.push(opt);
  }
  return map;
}

/**
 * Returns active experiences for a center, with bundled items and the
 * center-specific QAMF web offer ID pre-joined.
 * Optionally filter by kind ('kbf' | 'open' | 'hourly').
 */
export async function getBowlingExperiences(
  centerCode: string,
  kind?: BowlingExperienceKind,
): Promise<BowlingExperienceWithDetails[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();

  // 1. Fetch experience rows joined to the center's offer
  const offerRows = kind
    ? await q`
        SELECT e.*, eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id
        FROM bowling_experiences e
        JOIN bowling_experience_offers eo
          ON eo.experience_id = e.id
         AND eo.center_code   = ${centerCode}
         AND eo.is_active      = TRUE
        WHERE e.is_active = TRUE AND e.kind = ${kind}
        ORDER BY e.sort_order, e.id
      `
    : await q`
        SELECT e.*, eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id
        FROM bowling_experiences e
        JOIN bowling_experience_offers eo
          ON eo.experience_id = e.id
         AND eo.center_code   = ${centerCode}
         AND eo.is_active      = TRUE
        WHERE e.is_active = TRUE
        ORDER BY e.sort_order, e.id
      `;

  if (!offerRows.length) return [];

  // 2. Fetch items + duration options for those experiences in parallel
  const ids = offerRows.map((r) => (r as Record<string, unknown>).id as number);
  const [itemMap, durationMap] = await Promise.all([
    fetchExperienceItems(q, ids, centerCode),
    fetchDurationOptions(q, ids, centerCode),
  ]);

  return offerRows.map((r) => {
    const row = r as Record<string, unknown>;
    const eid = row.id as number;
    return {
      ...rowToExperience(row),
      qamfWebOfferId: row.qamf_web_offer_id as number,
      qamfOptionType: (row.qamf_option_type as string) ?? null,
      qamfOptionId: row.qamf_option_id != null ? (row.qamf_option_id as number) : null,
      items: itemMap.get(eid) ?? [],
      durationOptions: durationMap.get(eid) ?? [],
    };
  });
}

/**
 * Look up the experience for a specific QAMF web offer ID at a center.
 * Used when a QAMF availability slot needs to be matched to an experience.
 */
export async function getBowlingExperienceByOffer(
  centerCode: string,
  qamfWebOfferId: number,
): Promise<BowlingExperienceWithDetails | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();

  const offerRows = await q`
    SELECT e.*, eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id
    FROM bowling_experiences e
    JOIN bowling_experience_offers eo
      ON eo.experience_id    = e.id
     AND eo.center_code       = ${centerCode}
     AND eo.qamf_web_offer_id = ${qamfWebOfferId}
     AND eo.is_active          = TRUE
    WHERE e.is_active = TRUE
    LIMIT 1
  `;

  if (!offerRows.length) return null;
  const row = offerRows[0] as Record<string, unknown>;
  const eid = row.id as number;
  const [itemMap, durationMap] = await Promise.all([
    fetchExperienceItems(q, [eid], centerCode),
    fetchDurationOptions(q, [eid], centerCode),
  ]);

  return {
    ...rowToExperience(row),
    qamfWebOfferId: row.qamf_web_offer_id as number,
    qamfOptionType: (row.qamf_option_type as string) ?? null,
    qamfOptionId: row.qamf_option_id != null ? (row.qamf_option_id as number) : null,
    items: itemMap.get(eid) ?? [],
    durationOptions: durationMap.get(eid) ?? [],
  };
}

/**
 * Upsert an experience by slug. Used by the admin endpoint.
 */
export async function upsertBowlingExperience(
  e: Omit<BowlingExperience, "id" | "insertedAt">,
): Promise<BowlingExperience> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    INSERT INTO bowling_experiences (slug, label, kind, is_vip, description, sort_order, is_active)
    VALUES (${e.slug}, ${e.label}, ${e.kind}, ${e.isVip}, ${e.description ?? null}, ${e.sortOrder}, ${e.isActive})
    ON CONFLICT (slug) DO UPDATE SET
      label      = EXCLUDED.label,
      kind       = EXCLUDED.kind,
      is_vip     = EXCLUDED.is_vip,
      description = EXCLUDED.description,
      sort_order  = EXCLUDED.sort_order,
      is_active   = EXCLUDED.is_active
    RETURNING *
  `;
  return rowToExperience(rows[0] as Record<string, unknown>);
}

/**
 * Upsert a per-center QAMF web offer mapping for an experience.
 * Matches on (center_code, qamf_web_offer_id).
 */
export async function upsertBowlingExperienceOffer(
  o: Omit<BowlingExperienceOffer, "id">,
): Promise<BowlingExperienceOffer> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    INSERT INTO bowling_experience_offers
      (experience_id, center_code, qamf_web_offer_id, qamf_option_type, qamf_option_id, is_active)
    VALUES
      (${o.experienceId}, ${o.centerCode}, ${o.qamfWebOfferId},
       ${o.qamfOptionType ?? null}, ${o.qamfOptionId ?? null}, ${o.isActive})
    ON CONFLICT (center_code, qamf_web_offer_id) DO UPDATE SET
      experience_id    = EXCLUDED.experience_id,
      qamf_option_type = EXCLUDED.qamf_option_type,
      qamf_option_id   = EXCLUDED.qamf_option_id,
      is_active        = EXCLUDED.is_active
    RETURNING *
  `;
  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as number,
    experienceId: row.experience_id as number,
    centerCode: row.center_code as string,
    qamfWebOfferId: row.qamf_web_offer_id as number,
    qamfOptionType: (row.qamf_option_type as string) ?? null,
    qamfOptionId: row.qamf_option_id != null ? (row.qamf_option_id as number) : null,
    isActive: row.is_active as boolean,
  };
}

/**
 * Replace all bundled items for an experience in a single operation.
 * Deletes existing items first, then inserts new ones.
 */
export async function setBowlingExperienceItems(
  experienceId: number,
  items: Array<{
    squareProductId?: number;
    squareCatalogObjectId?: string;
    quantity?: number;
    labelOverride?: string | null;
    sortOrder?: number;
    /** NULL = applies to all centers; value = this center only (e.g. FM-only Chips & Salsa) */
    centerCode?: string | null;
  }>,
): Promise<void> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureBowlingSchema();
  const q = sql();
  await q`DELETE FROM bowling_experience_items WHERE experience_id = ${experienceId}`;
  for (const [i, item] of items.entries()) {
    // Resolve squareCatalogObjectId from squareProductId if not directly provided
    let catalogObjectId = item.squareCatalogObjectId ?? null;
    if (!catalogObjectId && item.squareProductId) {
      const pRows = await q`SELECT square_catalog_object_id FROM bowling_square_products WHERE id = ${item.squareProductId} LIMIT 1`;
      catalogObjectId = pRows.length ? (pRows[0] as Record<string, unknown>).square_catalog_object_id as string : null;
    }
    await q`
      INSERT INTO bowling_experience_items
        (experience_id, square_product_id, square_catalog_object_id, quantity, label_override, sort_order, center_code)
      VALUES
        (${experienceId}, ${item.squareProductId ?? null}, ${catalogObjectId},
         ${item.quantity ?? 1}, ${item.labelOverride ?? null}, ${item.sortOrder ?? i},
         ${item.centerCode ?? null})
    `;
  }
}

/**
 * Upsert duration options for a Time-based experience at a specific center.
 * Replaces ALL existing options for (experience_id, center_code).
 */
export async function setExperienceDurationOptions(
  experienceId: number,
  centerCode: string,
  options: Array<{
    qamfOptionId: number;
    durationMinutes: number;
    label: string;
    squareMultiplier?: number;
    sortOrder?: number;
  }>,
): Promise<void> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureBowlingSchema();
  const q = sql();
  await q`
    DELETE FROM bowling_experience_duration_options
    WHERE experience_id = ${experienceId} AND center_code = ${centerCode}
  `;
  for (const [i, opt] of options.entries()) {
    await q`
      INSERT INTO bowling_experience_duration_options
        (experience_id, center_code, qamf_option_id, duration_minutes, label, square_multiplier, sort_order)
      VALUES
        (${experienceId}, ${centerCode}, ${opt.qamfOptionId}, ${opt.durationMinutes},
         ${opt.label}, ${opt.squareMultiplier ?? 1}, ${opt.sortOrder ?? i})
    `;
  }
}

/**
 * Returns ALL experiences (all centers, all kinds) for admin listing.
 * Includes offers and items per experience.
 */
export async function getAllBowlingExperiences(): Promise<
  Array<BowlingExperience & { offers: BowlingExperienceOffer[]; items: BowlingExperienceItem[] }>
> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();

  const expRows = await q`
    SELECT * FROM bowling_experiences ORDER BY kind, sort_order, id
  `;
  if (!expRows.length) return [];

  const ids = expRows.map((r) => (r as Record<string, unknown>).id as number);

  const offerRows = await q`
    SELECT * FROM bowling_experience_offers WHERE experience_id = ANY(${ids})
  `;
  const itemMap = await fetchExperienceItems(q, ids);

  return expRows.map((eRow) => {
    const r = eRow as Record<string, unknown>;
    const eid = r.id as number;

    const offers = offerRows
      .filter((o) => (o as Record<string, unknown>).experience_id === eid)
      .map((o) => {
        const or = o as Record<string, unknown>;
        return {
          id: or.id as number,
          experienceId: or.experience_id as number,
          centerCode: or.center_code as string,
          qamfWebOfferId: or.qamf_web_offer_id as number,
          qamfOptionType: (or.qamf_option_type as string) ?? null,
          qamfOptionId: or.qamf_option_id != null ? (or.qamf_option_id as number) : null,
          isActive: or.is_active as boolean,
        } satisfies BowlingExperienceOffer;
      });

    return { ...rowToExperience(r), offers, items: itemMap.get(eid) ?? [] };
  });
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
