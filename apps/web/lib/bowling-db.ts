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
  //   1.5hr → multiplier 1  (charge base items × 1, using the 1.5hr catalog item)
  //   2hr   → multiplier 2  (charge override item × 2, i.e. two 1hr units)
  // override_square_product_id: when set, use this product instead of the
  //   base experience item for pricing and Square catalog linkage.
  //   Null = use base experience item (default for 1.5hr).
  //   Set to the 1hr Square product for 2hr options.
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

  // override_square_product_id: use this product instead of base experience item
  // for pricing and Square catalog linkage (e.g. 2hr uses the 1hr catalog item × 2).
  await q`ALTER TABLE bowling_experience_duration_options ADD COLUMN IF NOT EXISTS override_square_product_id INTEGER REFERENCES bowling_square_products(id)`;

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

  // ── days_of_week on experiences (idempotent) ─────────────────────
  // Integer array: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat.
  // Default all-days so old rows continue to work until seed is re-run.
  await q`ALTER TABLE bowling_experiences ADD COLUMN IF NOT EXISTS days_of_week INTEGER[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}'`;

  // ── square_modifier_list_ids on experiences (idempotent) ─────────
  // Square catalog modifier list IDs to surface for this experience.
  // Default empty so existing rows show no modifier step until seeded.
  await q`ALTER TABLE bowling_experiences ADD COLUMN IF NOT EXISTS square_modifier_list_ids TEXT[] NOT NULL DEFAULT '{}'`;

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

  // ── QAMF confirmation retry tracking (idempotent) ─────────────────
  // When a paid booking's QAMF status cannot be confirmed at submit time,
  // status is set to 'confirm_pending' and qamf_confirm_attempts tracks
  // how many retry attempts the cron has made. After MAX_QAMF_CONFIRM_ATTEMPTS
  // the status becomes 'confirm_failed' and staff are alerted.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS qamf_confirm_attempts INTEGER NOT NULL DEFAULT 0`;
  await q`CREATE INDEX IF NOT EXISTS br_confirm_pending ON bowling_reservations(id) WHERE status = 'confirm_pending'`;

  await q`ALTER TABLE bowling_reservation_players ADD COLUMN IF NOT EXISTS lane_number INTEGER`;

  // ── Short code for confirmation links (idempotent) ────────────────
  // Stable 6-char base64url code stored at booking time. Reused for
  // admin board links, email notifications, and SMS — avoids exposing
  // the Neon ID in customer-facing URLs.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS short_code TEXT`;

  // ── Lane-open tracking (idempotent) ──────────────────────────────
  // Set when the bowling-lane-poll / bowling-events-consumer cron processes
  // the day-of Square order (kitchen notes + gift card payment) on lane open.
  // dayof_order_sent_at IS NULL = not yet processed; used as idempotency guard.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS dayof_order_sent_at TIMESTAMPTZ`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS dayof_order_lane     TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS dayof_payment_id     TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS dayof_order_error    TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS dayof_order_source   TEXT`;

  // Pre-arrival SMS/email notification sent 30 min before booked_at.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS pre_arrival_sent_at TIMESTAMPTZ`;

  // Lane-ready SMS/email notification sent when lanes are physically ready.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS lane_ready_sent_at TIMESTAMPTZ`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS booking_source TEXT NOT NULL DEFAULT 'web'`;

  // Square customer ID — links to loyalty account for point accrual.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS square_customer_id TEXT`;

  // Square Loyalty reward ID — created when a member redeems Pinz at booking time.
  // Stored so cancellation can DELETE the reward (returning points to the account).
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS square_loyalty_reward_id TEXT`;
  // Discount amount in cents from the redeemed reward (e.g. 1000 = $10 off).
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS reward_discount_cents INT NOT NULL DEFAULT 0`;

  // Attraction add-ons booked via BMI during the bowling wizard.
  // JSON array of { slug, name, bmiOrderId, bmiBillLineId, quantity, totalPriceDollars, timeSlot, timeLabel }.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS attraction_bookings JSONB NOT NULL DEFAULT '[]'`;

  // Check-in method: 'self' (kiosk/self-service) or 'desk' (front desk staff).
  // Set by admin board; NULL = not yet checked in.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS checkin_method TEXT`;

  // Loyalty action during booking: 'signup' (new account), 'existing' (logged in),
  // or NULL (no loyalty interaction). Redemption tracked separately via
  // square_loyalty_reward_id + reward_discount_cents.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS loyalty_action TEXT`;

  schemaReady = true;
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type BowlingProductKind =
  | "kbf" // base KBF lane item (referenced by experience_items; free)
  | "open" // base open bowling lane item (referenced by experience_items)
  | "hourly" // hourly lane item (referenced by experience_items)
  | "addon_shoe" // shoe rental (optional per-person add-on)
  | "addon_attraction" // laser tag / gel blaster / escape room (stub)
  | "addon_food"; // F&B packages (stub)

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
  /**
   * Day-of-week availability: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat.
   * Wizard filters experiences by this before probing QAMF.
   * Default [0..6] (all days) so legacy rows work until seed is re-run.
   */
  daysOfWeek: number[];
  /**
   * Square catalog modifier list IDs to show for this experience's wizard step.
   * For pizza-bowl packages these are "Pizza Toppings" + "Soda Choice".
   * The catalog-modifiers endpoint fetches options for these lists from Square.
   * Empty array (default) means no modifier step is shown.
   */
  squareModifierListIds: string[];
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
  label: string; // label_override ?? product.label
  priceCents: number;
  depositPct: number;
  squareCatalogObjectId: string;
  quantity: number;
  sortOrder: number;
  productKind: string; // from bowling_square_products.product_kind
}

export interface BowlingExperienceOffer {
  id: number;
  experienceId: number;
  centerCode: string;
  qamfWebOfferId: number;
  qamfOptionType: string | null; // 'Game' | 'Time' | 'Unlimited'
  qamfOptionId: number | null;
  isActive: boolean;
}

export interface BowlingExperienceDurationOption {
  id: number;
  experienceId: number;
  centerCode: string;
  qamfOptionId: number;
  durationMinutes: number;
  label: string; // "1.5 Hours", "2 Hours"
  squareMultiplier: number; // quantity multiplier on base experience items
  sortOrder: number;
  /** When set, use this product instead of the base experience item for pricing + catalog linkage. */
  overrideSquareProductId: number | null;
  /** Price (cents) of the override product — null when no override. */
  overridePriceCents: number | null;
  /** Deposit % of the override product — null when no override. */
  overrideDepositPct: number | null;
  /** Square catalog object ID of the override product — null when no override. */
  overrideCatalogObjectId: string | null;
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
  /** QAMF lane number this player is assigned to (e.g. 12, 13). null = unassigned. */
  laneNumber: number | null;
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
  laneNumber?: number | null;
};

export interface BowlingReservation {
  id: number;
  centerCode: string;
  productKind: "kbf" | "open";
  qamfReservationId?: string;
  /** BMI bill ID — always a raw string; never coerce to Number. */
  bmiBillId?: string;
  bmiReservationNumber?: string;
  /** Square deposit order ID — closed immediately when the deposit payment is captured. */
  squareDepositOrderId?: string;
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
  status:
    | "confirmed"
    | "confirm_pending"
    | "confirm_failed"
    | "arrived"
    | "completed"
    | "cancelled";
  /** Number of times the QAMF confirmation has been retried by the cron. */
  qamfConfirmAttempts: number;
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
  /** Stable 6-char short code for confirmation links (stored at booking time). */
  shortCode?: string;
  /** ISO timestamp set when the lane-open processor runs (kitchen notes + gift card payment). */
  dayofOrderSentAt?: string;
  /** Comma-separated lane numbers assigned when lanes opened, e.g. "12" or "12,13". */
  dayofOrderLane?: string;
  /** Square payment ID for the gift card charge applied at lane-open. */
  dayofPaymentId?: string;
  /** Error message from last lane-open attempt (if any); cleared on success. */
  dayofOrderError?: string;
  /** How the lane-open was triggered: "webhook" (events-consumer) or "cron" (lane-poll). */
  dayofOrderSource?: string;
  /** ISO timestamp when the pre-arrival SMS/email was sent (~30 min before booked_at). */
  preArrivalSentAt?: string;
  /** ISO timestamp when the lane-ready SMS/email was sent (lanes physically ready). */
  laneReadySentAt?: string;
  /** Booking origin: "web" (headpinz.com), "kiosk" (K-prefix), "conqueror" (C-prefix staff POS), "admin" (staff KBF admin). Defaults to "web". */
  bookingSource?: "web" | "kiosk" | "conqueror" | "admin";
  /** Square customer ID — links to loyalty account for point accrual on day-of order. */
  squareCustomerId?: string;
  /** Square Loyalty reward ID — stored for cancellation cleanup (DELETE returns points). */
  squareLoyaltyRewardId?: string;
  /** Discount amount in cents from the redeemed loyalty reward (e.g. 1000 = $10 off deposit). */
  rewardDiscountCents: number;
  /** Check-in method: 'self' (kiosk/self-service), 'desk' (front desk), or undefined (not checked in). */
  checkinMethod?: "self" | "desk";
  /** Loyalty action during booking: 'signup' (new account created), 'existing' (logged in with existing). */
  loyaltyAction?: "signup" | "existing";
  /** Attraction add-ons booked via BMI during the bowling wizard (laser tag, gel blaster, etc.). */
  attractionBookings: Array<{
    slug: string;
    name: string;
    bmiOrderId: string | null;
    bmiBillLineId: string | null;
    squareCatalogObjectId: string | null;
    quantity: number;
    totalPriceDollars: number;
    timeSlot: string;
    timeLabel: string;
  }>;
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
    squareGiftCardId: (row.square_gift_card_id as string) ?? undefined,
    squareGiftCardGan: (row.square_gift_card_gan as string) ?? undefined,
    depositCents: row.deposit_cents as number,
    totalCents: row.total_cents as number,
    status: row.status as BowlingReservation["status"],
    qamfConfirmAttempts: (row.qamf_confirm_attempts as number) ?? 0,
    bookedAt: (row.booked_at as Date).toISOString(),
    playerCount: (row.player_count as number) ?? undefined,
    guestName: (row.guest_name as string) ?? undefined,
    guestEmail: (row.guest_email as string) ?? undefined,
    guestPhone: (row.guest_phone as string) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    cancelledAt: row.cancelled_at ? (row.cancelled_at as Date).toISOString() : undefined,
    squareRefundId: (row.square_refund_id as string) ?? undefined,
    refundCents: (row.refund_cents as number) ?? 0,
    shortCode: (row.short_code as string) ?? undefined,
    dayofOrderSentAt: row.dayof_order_sent_at
      ? (row.dayof_order_sent_at as Date).toISOString()
      : undefined,
    dayofOrderLane: (row.dayof_order_lane as string) ?? undefined,
    dayofPaymentId: (row.dayof_payment_id as string) ?? undefined,
    dayofOrderError: (row.dayof_order_error as string) ?? undefined,
    dayofOrderSource: (row.dayof_order_source as string) ?? undefined,
    preArrivalSentAt: row.pre_arrival_sent_at
      ? (row.pre_arrival_sent_at as Date).toISOString()
      : undefined,
    laneReadySentAt: row.lane_ready_sent_at
      ? (row.lane_ready_sent_at as Date).toISOString()
      : undefined,
    bookingSource: (row.booking_source as BowlingReservation["bookingSource"]) ?? "web",
    squareCustomerId: (row.square_customer_id as string) ?? undefined,
    squareLoyaltyRewardId: (row.square_loyalty_reward_id as string) ?? undefined,
    rewardDiscountCents: (row.reward_discount_cents as number) ?? 0,
    checkinMethod: (row.checkin_method as BowlingReservation["checkinMethod"]) ?? undefined,
    loyaltyAction: (row.loyalty_action as BowlingReservation["loyaltyAction"]) ?? undefined,
    attractionBookings: (() => {
      const raw = row.attraction_bookings;
      if (!raw) return [];
      if (typeof raw === "string")
        try {
          return JSON.parse(raw);
        } catch {
          return [];
        }
      if (Array.isArray(raw)) return raw;
      return [];
    })(),
    insertedAt: (row.inserted_at as Date).toISOString(),
  };
}

function rowToLine(
  row: Record<string, unknown>,
): ReservationLine & { id: number; reservationId: number } {
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
  r: Omit<
    BowlingReservation,
    | "id"
    | "insertedAt"
    | "cancelledAt"
    | "squareRefundId"
    | "refundCents"
    | "qamfConfirmAttempts"
    | "rewardDiscountCents"
    | "attractionBookings"
    | "checkinMethod"
  > & {
    rewardDiscountCents?: number;
    attractionBookings?: BowlingReservation["attractionBookings"];
  },
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
      square_gift_card_id, square_gift_card_gan,
      deposit_cents, total_cents, status,
      booked_at, player_count,
      guest_name, guest_email, guest_phone, notes,
      booking_source, square_customer_id,
      square_loyalty_reward_id, reward_discount_cents,
      loyalty_action, attraction_bookings
    ) VALUES (
      ${r.centerCode}, ${r.productKind},
      ${r.qamfReservationId ?? null}, ${r.bmiBillId ?? null}, ${r.bmiReservationNumber ?? null},
      ${r.squareDepositOrderId ?? null}, ${r.squareDepositPaymentId ?? null}, ${r.squareDayofOrderId ?? null},
      ${r.squareGiftCardId ?? null}, ${r.squareGiftCardGan ?? null},
      ${r.depositCents}, ${r.totalCents}, ${r.status},
      ${r.bookedAt}, ${r.playerCount ?? null},
      ${r.guestName ?? null}, ${r.guestEmail ?? null}, ${r.guestPhone ?? null}, ${r.notes ?? null},
      ${r.bookingSource ?? "web"}, ${r.squareCustomerId ?? null},
      ${r.squareLoyaltyRewardId ?? null}, ${r.rewardDiscountCents ?? 0},
      ${r.loyaltyAction ?? null}, ${JSON.stringify(r.attractionBookings ?? [])}::jsonb
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
): Promise<
  | (BowlingReservation & { lines: (ReservationLine & { id: number; reservationId: number })[] })
  | null
> {
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

/**
 * Look up a reservation by QAMF reservation ID.
 * Used by the webhook consumer to find the Neon row for an incoming event.
 */
export async function getBowlingReservationByQamfId(
  qamfReservationId: string,
): Promise<
  | (BowlingReservation & { lines: (ReservationLine & { id: number; reservationId: number })[] })
  | null
> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE qamf_reservation_id = ${qamfReservationId}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const reservation = rowToReservation(rows[0] as Record<string, unknown>);
  const lineRows = await q`
    SELECT * FROM bowling_reservation_lines WHERE reservation_id = ${reservation.id} ORDER BY id
  `;
  return {
    ...reservation,
    lines: lineRows.map((r) => rowToLine(r as Record<string, unknown>)),
  };
}

/**
 * Look up a reservation by short_code (the 6-char random code in /s/{code} URLs).
 * Used by the confirmation page so neonId never appears in the browser URL.
 */
export async function getBowlingReservationByShortCode(
  shortCode: string,
): Promise<
  | (BowlingReservation & { lines: (ReservationLine & { id: number; reservationId: number })[] })
  | null
> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE short_code = ${shortCode}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const reservation = rowToReservation(rows[0] as Record<string, unknown>);
  const lineRows = await q`
    SELECT * FROM bowling_reservation_lines WHERE reservation_id = ${reservation.id} ORDER BY id
  `;
  return {
    ...reservation,
    lines: lineRows.map((r) => rowToLine(r as Record<string, unknown>)),
  };
}

export type BowlingReservationWithLines = BowlingReservation & {
  lines: (ReservationLine & { id: number; reservationId: number })[];
};

/**
 * List bowling reservations filtered by booked_at date range.
 * Used by the admin reservations board. Includes order lines.
 */
export async function listBowlingReservations(opts: {
  startDate: string; // 'YYYY-MM-DD' inclusive
  endDate: string; // 'YYYY-MM-DD' inclusive
  centerCode?: string;
}): Promise<BowlingReservationWithLines[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  // Convert booked_at to ET date and compare directly.  Previous approach
  // (`$1::date AT TIME ZONE 'America/New_York'`) broke because the Neon sql
  // template tag consumed `::date` as a parameter type hint, stripping it from
  // the SQL — so the AT TIME ZONE was applied to a bare text parameter, which
  // Postgres silently mis-interpreted.  Casting the column side is unambiguous.
  const rows = opts.centerCode
    ? await q`
        SELECT * FROM bowling_reservations
        WHERE (booked_at AT TIME ZONE 'America/New_York')::date >= ${opts.startDate}::date
          AND (booked_at AT TIME ZONE 'America/New_York')::date <= ${opts.endDate}::date
          AND center_code = ${opts.centerCode}
        ORDER BY booked_at ASC
      `
    : await q`
        SELECT * FROM bowling_reservations
        WHERE (booked_at AT TIME ZONE 'America/New_York')::date >= ${opts.startDate}::date
          AND (booked_at AT TIME ZONE 'America/New_York')::date <= ${opts.endDate}::date
        ORDER BY booked_at ASC
      `;
  const reservations = rows.map((r) => rowToReservation(r as Record<string, unknown>));
  if (!reservations.length) return [];

  // Batch-fetch lines for all reservations in one query
  const ids = reservations.map((r) => r.id);
  const lineRows = await q`
    SELECT * FROM bowling_reservation_lines
    WHERE reservation_id = ANY(${ids})
    ORDER BY id
  `;
  const linesByRes = new Map<number, (ReservationLine & { id: number; reservationId: number })[]>();
  for (const lr of lineRows) {
    const line = rowToLine(lr as Record<string, unknown>);
    const arr = linesByRes.get(line.reservationId) ?? [];
    arr.push(line);
    linesByRes.set(line.reservationId, arr);
  }

  return reservations.map((r) => ({
    ...r,
    lines: linesByRes.get(r.id) ?? [],
  }));
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

/** Sync booked_at when QAMF sends a different time (e.g. manual reschedule in Conqueror). */
export async function updateBowlingReservationBookedAt(
  id: number,
  bookedAt: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`UPDATE bowling_reservations SET booked_at = ${bookedAt} WHERE id = ${id}`;
}

/** Set check-in method on a reservation (admin action). */
export async function updateBowlingCheckinMethod(
  id: number,
  method: "self" | "desk" | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`UPDATE bowling_reservations SET checkin_method = ${method} WHERE id = ${id}`;
}

/**
 * Find confirmed reservations whose booked_at is between `windowStart` and
 * `windowEnd` (ET-aware) and pre_arrival_sent_at IS NULL.
 * Used by the pre-arrival cron to send 30-min-out notifications.
 */
export async function getReservationsNeedingPreArrival(
  windowStart: Date,
  windowEnd: Date,
): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE booked_at >= ${windowStart.toISOString()}
      AND booked_at <= ${windowEnd.toISOString()}
      AND pre_arrival_sent_at IS NULL
      AND status IN ('confirmed', 'confirm_pending')
    ORDER BY booked_at ASC
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/** Mark pre-arrival notification as sent (idempotent — only writes once). */
export async function markPreArrivalSent(id: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET pre_arrival_sent_at = NOW()
    WHERE id = ${id} AND pre_arrival_sent_at IS NULL
  `;
}

/**
 * Find today's reservations (ET) that need a lane-ready notification.
 * Used by the pre-arrival cron (now repurposed as lane-ready fallback)
 * and the webhook handler.
 */
export async function getTodayReservationsNeedingLaneReady(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  // Compute today's start/end in Eastern Time
  const nowET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const todayStart = `${nowET}T00:00:00-04:00`;
  const todayEnd = `${nowET}T23:59:59-04:00`;
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE booked_at >= ${todayStart}
      AND booked_at <= ${todayEnd}
      AND lane_ready_sent_at IS NULL
      AND status IN ('confirmed', 'confirm_pending', 'arrived')
    ORDER BY booked_at ASC
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/** Mark lane-ready notification as sent (idempotent — only writes once). */
export async function markLaneReadySent(id: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET lane_ready_sent_at = NOW()
    WHERE id = ${id} AND lane_ready_sent_at IS NULL
  `;
}

/**
 * Sync guest + player data from QAMF into a kiosk/conqueror Neon row.
 *
 * Called on every `reservation.updated` webhook for K/C reservations.
 * Guest name/email/phone may change (kiosk collects data AFTER creating
 * the reservation), and player count can change with lane reassignment,
 * so we always overwrite — not just when null.
 */
export async function updateWalkinGuestData(
  id: number,
  opts: {
    guestName?: string | null;
    guestEmail?: string | null;
    guestPhone?: string | null;
    playerCount?: number | null;
  },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET guest_name   = ${opts.guestName ?? null},
        guest_email  = ${opts.guestEmail ?? null},
        guest_phone  = ${opts.guestPhone ?? null},
        player_count = COALESCE(${opts.playerCount ?? null}, player_count)
    WHERE id = ${id}
  `;
}

/**
 * Write the Square day-of order ID to a reservation (used by walkin/kiosk
 * reservations that don't have a Square order at booking time).
 */
export async function updateSquareDayofOrderId(id: number, orderId: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET square_dayof_order_id = ${orderId}
    WHERE id = ${id}
  `;
}

/** Max QAMF confirmation attempts before the row flips to 'confirm_failed'. */
export const MAX_QAMF_CONFIRM_ATTEMPTS = 5;

/**
 * Returns all reservations in 'confirm_pending' status, ordered oldest first.
 * Used by the bowling-confirm-retry cron to drive automatic retries.
 */
export async function getPendingQamfConfirms(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE status = 'confirm_pending'
    ORDER BY inserted_at ASC
    LIMIT 20
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * Increment qamf_confirm_attempts and optionally update the status.
 * Called by the bowling-confirm-retry cron after each retry attempt.
 */
export async function incrementQamfConfirmAttempt(
  id: number,
  newStatus: BowlingReservation["status"],
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET
      qamf_confirm_attempts = qamf_confirm_attempts + 1,
      status = ${newStatus}
    WHERE id = ${id}
  `;
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
 * Store a short code on a reservation.
 * Called once at booking time — the code lives in Redis (for redirect resolution)
 * AND in Neon (for stable reuse across admin board, emails, SMS).
 */
export async function updateBowlingReservationShortCode(
  id: number,
  shortCode: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET short_code = ${shortCode}
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
): Promise<
  | (BowlingReservation & { lines: (ReservationLine & { id: number; reservationId: number })[] })
  | null
> {
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
 * Returns KBF pass-member pairs that already have a non-cancelled KBF
 * reservation on the given date (ET local). Used to enforce the
 * "2 free games per person per day" cap at booking time.
 *
 * @param date  YYYY-MM-DD in America/New_York
 * @param pairs Array of { passId, slot } from the selected bowlers
 * @param excludeReservationId  Optional — exclude this reservation
 *        (used by reschedule so moving from Mon→Tue doesn't block Mon)
 * @returns Subset of pairs that have already redeemed on that date
 */
export async function getKbfRedeemedMembers(
  date: string,
  pairs: { passId: number; slot: number }[],
  excludeReservationId?: number,
): Promise<{ passId: number; slot: number }[]> {
  if (!isDbConfigured()) return [];
  if (pairs.length === 0) return [];
  await ensureBowlingSchema();
  const q = sql();

  // Build pairs array for SQL ANY match
  const passIds = pairs.map((p) => p.passId);
  const slots = pairs.map((p) => p.slot);

  const rows = await q`
    SELECT DISTINCT brp.kbf_pass_id AS pass_id, brp.kbf_member_slot AS slot
    FROM bowling_reservation_players brp
    JOIN bowling_reservations br ON br.id = brp.reservation_id
    WHERE br.product_kind = 'kbf'
      AND br.status NOT IN ('cancelled')
      AND (br.booked_at AT TIME ZONE 'America/New_York')::date = ${date}::date
      AND brp.kbf_pass_id = ANY(${passIds}::int[])
      AND brp.kbf_member_slot = ANY(${slots}::int[])
      ${excludeReservationId ? q`AND br.id != ${excludeReservationId}` : q``}
  `;

  // Filter to exact passId+slot pairs (the ANY match is per-column, not paired)
  const pairSet = new Set(pairs.map((p) => `${p.passId}|${p.slot}`));
  return (rows as { pass_id: number; slot: number }[])
    .filter((r) => pairSet.has(`${r.pass_id}|${r.slot}`))
    .map((r) => ({ passId: r.pass_id, slot: r.slot }));
}

/**
 * Check whether any KBF pass already has a confirmed/pending future reservation.
 * Used by admin to prevent double-booking Book Lane when a reservation exists.
 */
export async function getKbfFutureReservationsByPass(
  passIds: number[],
): Promise<{ passId: number; reservationId: number; bookedAt: string }[]> {
  if (!isDbConfigured()) return [];
  if (passIds.length === 0) return [];
  await ensureBowlingSchema();
  const q = sql();

  const rows = await q`
    SELECT DISTINCT ON (brp.kbf_pass_id)
      brp.kbf_pass_id AS pass_id,
      br.id AS reservation_id,
      br.booked_at
    FROM bowling_reservations br
    JOIN bowling_reservation_players brp ON brp.reservation_id = br.id
    WHERE brp.kbf_pass_id = ANY(${passIds}::int[])
      AND br.product_kind = 'kbf'
      AND br.status IN ('confirmed', 'pending')
      AND br.booked_at > now()
    ORDER BY brp.kbf_pass_id, br.booked_at ASC
  `;

  return (rows as { pass_id: number; reservation_id: number; booked_at: string }[]).map((r) => ({
    passId: r.pass_id,
    reservationId: r.reservation_id,
    bookedAt: r.booked_at,
  }));
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
    SET booked_at = ${bookedAt},
        qamf_reservation_id = ${qamfReservationId},
        attraction_bookings = '[]'::jsonb
    WHERE id = ${id}
  `;
}

/**
 * Build the formatted QAMF Notes memo for a reservation.
 * Used at booking time, after reschedule, and by the backfill-memo endpoint.
 *
 * Format:
 *   Line 1: shoe status | short URL
 *   Line 2: line items with quantities and prices
 *   Line 3: deposit amount (incl. tax)
 *   Line 4: customer notes (if any)
 */
const SHOES_INCLUDED_RE = /fun\s*4\s*all|pizza\s*bowl/i;

export async function buildQamfMemo(reservationId: number): Promise<string> {
  const q = sql();
  const resRows = await q`
    SELECT deposit_cents, notes, short_code
    FROM bowling_reservations WHERE id = ${reservationId}
  `;
  if (!resRows.length) return "";
  const res = resRows[0] as {
    deposit_cents: number;
    notes: string | null;
    short_code: string | null;
  };

  const lines = (await q`
    SELECT brl.label, brl.quantity, brl.unit_price_cents, bsp.product_kind
    FROM bowling_reservation_lines brl
    LEFT JOIN bowling_square_products bsp ON bsp.id = brl.square_product_id
    WHERE brl.reservation_id = ${reservationId}
    ORDER BY brl.id
  `) as unknown as Array<{
    label: string;
    quantity: number;
    unit_price_cents: number;
    product_kind: string | null;
  }>;

  const parts: string[] = [];

  // Shoe status + short URL
  const hasShoeAddOn = lines.some((l) => l.product_kind === "addon_shoe");
  const shoesIncluded = lines.some((l) => SHOES_INCLUDED_RE.test(l.label));
  let shoeLine: string;
  if (hasShoeAddOn) {
    const shoeQty = lines
      .filter((l) => l.product_kind === "addon_shoe")
      .reduce((s, l) => s + l.quantity, 0);
    shoeLine = `${shoeQty} pair${shoeQty !== 1 ? "s" : ""} shoes paid`;
  } else if (shoesIncluded) {
    shoeLine = "Shoes included";
  } else {
    shoeLine = "SHOES NOT INCLUDED";
  }
  if (res.short_code) shoeLine += ` | headpinz.com/s/${res.short_code}`;
  parts.push(shoeLine);

  // Line items summary
  if (lines.length > 0) {
    const itemParts = lines.map((l) => {
      const total = l.quantity * l.unit_price_cents;
      const totalStr = `$${(total / 100).toFixed(2)}`;
      return l.quantity > 1 ? `${l.quantity}x ${l.label} ${totalStr}` : `${l.label} ${totalStr}`;
    });
    parts.push(itemParts.join(" + "));
  }

  // Tax-inclusive deposit
  if (res.deposit_cents > 0) {
    parts.push(`Deposit $${(res.deposit_cents / 100).toFixed(2)} paid (incl. tax)`);
  }

  // User-supplied notes
  if (res.notes) parts.push(res.notes);

  return parts.join("\n");
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
    laneNumber: row.lane_number != null ? (row.lane_number as number) : null,
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
         kbf_pass_id, kbf_member_slot, kbf_relation, lane_number)
      VALUES
        (${reservationId}, ${p.slot}, ${p.name ?? null}, ${p.shoeSize ?? null},
         ${p.bumpers ?? null}, ${p.kbfPassId ?? null},
         ${p.kbfMemberSlot ?? null}, ${p.kbfRelation ?? null}, ${p.laneNumber ?? null})
      ON CONFLICT (reservation_id, slot) DO NOTHING
    `;
  }
}

/**
 * Fetch players for a reservation plus the number of shoe pairs purchased.
 * shoePairsAllowed = sum of addon_shoe line quantities, OR the full
 * player count when the experience itself includes shoes (Fun 4 All,
 * Pizza Bowl). The confirmation page uses this to validate that shoe
 * sizes aren't assigned to more bowlers than shoes available.
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
  let shoePairsAllowed = Number((shoeRows[0] as Record<string, unknown>).shoe_qty ?? 0);

  // If no explicit shoe add-on was purchased, check whether the experience
  // itself includes shoes (Fun 4 All, Pizza Bowl). When it does, every
  // bowler gets shoes — allowance = player count.
  if (shoePairsAllowed === 0) {
    const labelRows = await q`
      SELECT label FROM bowling_reservation_lines
      WHERE reservation_id = ${reservationId}
    `;
    const includesShoes = labelRows.some((r) =>
      /fun\s*4\s*all|pizza\s*bowl/i.test(String((r as Record<string, unknown>).label ?? "")),
    );
    if (includesShoes) {
      shoePairsAllowed = playerRows.length;
    } else {
      // KBF includes shoes for all bowlers — no add-on line items exist
      const kindRows = await q`
        SELECT product_kind FROM bowling_reservations WHERE id = ${reservationId}
      `;
      if ((kindRows[0] as Record<string, unknown>)?.product_kind === "kbf") {
        shoePairsAllowed = playerRows.length;
      }
    }
  }

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
  update: {
    name?: string | null;
    shoeSize?: string | null;
    bumpers?: boolean | null;
    laneNumber?: number | null;
  },
): Promise<BowlingReservationPlayer | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    UPDATE bowling_reservation_players
    SET
      name        = CASE WHEN ${update.name !== undefined} THEN ${update.name ?? null} ELSE name END,
      shoe_size   = CASE WHEN ${update.shoeSize !== undefined} THEN ${update.shoeSize ?? null} ELSE shoe_size END,
      bumpers     = CASE WHEN ${update.bumpers !== undefined} THEN ${update.bumpers ?? null} ELSE bumpers END,
      lane_number = CASE WHEN ${update.laneNumber !== undefined} THEN ${update.laneNumber ?? null} ELSE lane_number END,
      updated_at  = NOW()
    WHERE reservation_id = ${reservationId} AND slot = ${slot}
    RETURNING *
  `;
  return rows.length ? rowToPlayer(rows[0] as Record<string, unknown>) : null;
}

// ─────────────────────────────────────────────────────────────────
// Experience catalog helpers
// ─────────────────────────────────────────────────────────────────

function rowToExperience(row: Record<string, unknown>): BowlingExperience {
  // days_of_week comes back as a JS number[] from Neon (pg INTEGER[])
  const raw = row.days_of_week;
  const daysOfWeek: number[] = Array.isArray(raw) ? (raw as number[]) : [0, 1, 2, 3, 4, 5, 6]; // fallback: all days

  // square_modifier_list_ids comes back as string[] from Neon (pg TEXT[])
  const rawMods = row.square_modifier_list_ids;
  const squareModifierListIds: string[] = Array.isArray(rawMods) ? (rawMods as string[]) : [];

  return {
    id: row.id as number,
    slug: row.slug as string,
    label: row.label as string,
    kind: row.kind as BowlingExperienceKind,
    isVip: row.is_vip as boolean,
    description: (row.description as string) ?? null,
    sortOrder: row.sort_order as number,
    isActive: row.is_active as boolean,
    daysOfWeek,
    squareModifierListIds,
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
          bei.id, bei.experience_id,
          -- Use the center-resolved product ID (bsp.id), not the seed-time
          -- bei.square_product_id which may reference a different center's row.
          -- e.g. pizza-bowl items were seeded with FM IDs; Naples must get its
          -- own product IDs so Square catalog object IDs, prices, etc. are correct.
          bsp.id AS square_product_id,
          COALESCE(bei.label_override, bsp.label) AS label,
          bsp.price_cents, bsp.deposit_pct, bsp.square_catalog_object_id,
          bsp.product_kind,
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
          bsp.product_kind,
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
      productKind: r.product_kind as string,
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
    SELECT d.*,
           op.price_cents   AS override_price_cents,
           op.deposit_pct   AS override_deposit_pct,
           op.square_catalog_object_id AS override_catalog_object_id
    FROM bowling_experience_duration_options d
    LEFT JOIN bowling_square_products op ON op.id = d.override_square_product_id
    WHERE d.experience_id = ANY(${experienceIds})
      AND d.center_code = ${centerCode}
    ORDER BY d.experience_id, d.sort_order
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
      overrideSquareProductId: (r.override_square_product_id as number) ?? null,
      overridePriceCents: (r.override_price_cents as number) ?? null,
      overrideDepositPct: (r.override_deposit_pct as number) ?? null,
      overrideCatalogObjectId: (r.override_catalog_object_id as string) ?? null,
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
  const days = e.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
  const modListIds = e.squareModifierListIds ?? [];
  const rows = await q`
    INSERT INTO bowling_experiences (slug, label, kind, is_vip, description, sort_order, is_active, days_of_week, square_modifier_list_ids)
    VALUES (${e.slug}, ${e.label}, ${e.kind}, ${e.isVip}, ${e.description ?? null}, ${e.sortOrder}, ${e.isActive}, ${days}, ${modListIds})
    ON CONFLICT (slug) DO UPDATE SET
      label                    = EXCLUDED.label,
      kind                     = EXCLUDED.kind,
      is_vip                   = EXCLUDED.is_vip,
      description              = EXCLUDED.description,
      sort_order               = EXCLUDED.sort_order,
      is_active                = EXCLUDED.is_active,
      days_of_week             = EXCLUDED.days_of_week,
      square_modifier_list_ids = EXCLUDED.square_modifier_list_ids
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
      const pRows =
        await q`SELECT square_catalog_object_id FROM bowling_square_products WHERE id = ${item.squareProductId} LIMIT 1`;
      catalogObjectId = pRows.length
        ? ((pRows[0] as Record<string, unknown>).square_catalog_object_id as string)
        : null;
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

/**
 * Mark a reservation's day-of order as processed after lane-open.
 *
 * Sets dayof_order_sent_at = NOW(), records lane numbers, payment ID, and
 * any error. Advances status to 'arrived' if it was 'confirmed' (or pending).
 *
 * Uses `WHERE dayof_order_sent_at IS NULL AND status != 'cancelled'` as the
 * idempotency guard — returns false if the row was already processed or
 * the reservation is cancelled.
 *
 * Called by both the bowling-events-consumer (webhook path) and the
 * bowling-lane-poll cron (polling fallback). Both use the same
 * idempotency keys so concurrent triggers are safe.
 */
export async function updateBowlingReservationLaneOpen(
  id: number,
  opts: { laneNumbers: number[]; paymentId?: string; error?: string; source?: string },
): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureBowlingSchema();
  const q = sql();
  const laneLabel = opts.laneNumbers.join(",");
  const rows = await q`
    UPDATE bowling_reservations SET
      dayof_order_sent_at = NOW(),
      dayof_order_lane    = ${laneLabel || null},
      dayof_payment_id    = ${opts.paymentId ?? null},
      dayof_order_error   = ${opts.error ?? null},
      dayof_order_source  = ${opts.source ?? null},
      status = CASE
        WHEN status IN ('confirmed', 'confirm_pending', 'confirm_failed') THEN 'arrived'
        ELSE status
      END
    WHERE id = ${id}
      AND dayof_order_sent_at IS NULL
      AND status != 'cancelled'
    RETURNING id
  `;
  return rows.length > 0;
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
