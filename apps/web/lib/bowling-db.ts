import { type NeonQueryFunction } from "@neondatabase/serverless";
import { sql, isDbConfigured } from "@/lib/db";
import { FASTTRAX_CENTER_CODE } from "@/lib/qamf-centers";

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

  // ── Configurable food items (2026-08-25) ─────────────────────────
  // A $0 package item (Pizza Bowl pizza, soda pitcher; NFL wings) can carry
  // Square modifier groups the guest picks from. These two columns say how many
  // picks are free and what each extra costs, so BowlingFoodStep is driven by
  // config instead of the hardcoded catalog ids + name regex it used to carry.
  //
  // included_modifier_count defaults to 1: every package to date includes
  // exactly one choice per group (one topping, one drink, one heat level).
  await q`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS included_modifier_count INTEGER NOT NULL DEFAULT 1`;
  await q`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS extra_modifier_cents INTEGER NOT NULL DEFAULT 0`;
  // Backfill so the behaviour does not change the moment this deploys: the
  // Pizza Bowl PIZZA item has always charged $1 per extra topping (the old
  // hardcoded PIZZA_BOWL_FREE_TOPPINGS / EXTRA_TOPPING_CENTS pair). Without
  // this, extra toppings would silently become free until the seed is re-run.
  // Guarded on `= 0` so a later deliberate change is never clobbered.
  await q`
    UPDATE bowling_experience_items
       SET extra_modifier_cents = 100
     WHERE square_catalog_object_id = '2IKZB4O2HQBXWMTSUQ2SEKJY'
       AND extra_modifier_cents = 0
  `;

  // ── bowling_experience_offers ────────────────────────────────────
  // Maps an experience to the QAMF web offer ID at a specific center.
  // Same experience → different offer IDs per center.
  // Multiple experiences CAN share the same web offer (e.g. Fun 4 All
  // and hourly lane rental both use the same QAMF Time offer).
  await q`
    CREATE TABLE IF NOT EXISTS bowling_experience_offers (
      id                  SERIAL  PRIMARY KEY,
      experience_id       INTEGER NOT NULL REFERENCES bowling_experiences(id),
      center_code         TEXT    NOT NULL,
      qamf_web_offer_id   INTEGER NOT NULL,
      qamf_option_type    TEXT,          -- 'Game' | 'Time' | 'Unlimited'
      qamf_option_id      INTEGER,
      is_active           BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE (experience_id, center_code)
    )
  `;
  // Migrate: drop the old unique constraint if it exists (was center_code + web_offer_id,
  // now experience_id + center_code to allow shared offers).
  await q`ALTER TABLE bowling_experience_offers DROP CONSTRAINT IF EXISTS bowling_experience_offers_center_code_qamf_web_offer_id_key`;
  // Deduplicate before creating unique index: keep only the most recently inserted
  // row per (experience_id, center_code). Stale duplicates exist when an experience
  // was re-seeded with a different web offer ID under the old constraint.
  await q`
    DELETE FROM bowling_experience_offers a
    USING bowling_experience_offers b
    WHERE a.experience_id = b.experience_id
      AND a.center_code   = b.center_code
      AND a.id < b.id
  `;
  await q`CREATE UNIQUE INDEX IF NOT EXISTS beo_exp_center ON bowling_experience_offers(experience_id, center_code)`;
  await q`CREATE INDEX IF NOT EXISTS beo_center ON bowling_experience_offers(center_code, qamf_web_offer_id)`;
  await q`CREATE INDEX IF NOT EXISTS beo_exp    ON bowling_experience_offers(experience_id)`;

  // duration_minutes (2026-07-19): the fixed duration of the offer-level
  // qamf_option_id for packages without duration buttons (Pizza Bowl 120,
  // Fun 4 All 90, World Cup 150). NULL for Game/Unlimited (KBF, midnight
  // madness) and for hourly offers (durations live in
  // bowling_experience_duration_options). Needed so the server can duration-
  // window-check fixed-duration packages at hold/reserve time — QAMF's own
  // Minutes field is unreliable and never read for logic.
  await q`ALTER TABLE bowling_experience_offers ADD COLUMN IF NOT EXISTS duration_minutes INTEGER`;
  await q`
    UPDATE bowling_experience_offers eo
    SET duration_minutes = CASE
          WHEN e.slug LIKE 'fun-4-all%'  THEN 90
          WHEN e.slug LIKE 'pizza-bowl%' THEN 120
          WHEN e.slug LIKE 'world-cup%'  THEN 150
        END
    FROM bowling_experiences e
    WHERE e.id = eo.experience_id
      AND eo.duration_minutes IS NULL
      AND (e.slug LIKE 'fun-4-all%' OR e.slug LIKE 'pizza-bowl%' OR e.slug LIKE 'world-cup%')
  `;

  // One-time migration: Fun 4 All switched from Unlimited to shared Time offers.
  // Old: FM=156/Naples=120, VIP FM=157/Naples=121
  // New: FM=154/Naples=118, VIP FM=155/Naples=119 (shared with hourly lane rental)
  await q`
    UPDATE bowling_experience_offers eo
    SET qamf_web_offer_id = CASE
          WHEN eo.qamf_web_offer_id = 156 THEN 154
          WHEN eo.qamf_web_offer_id = 120 THEN 118
        END,
        qamf_option_type = 'Time',
        qamf_option_id = CASE
          WHEN eo.center_code = 'TXBSQN0FEKQ11' THEN 1227
          WHEN eo.center_code = 'PPTR5G2N0QXF7' THEN 939
        END
    FROM bowling_experiences e
    WHERE e.id = eo.experience_id
      AND e.slug = 'fun-4-all'
      AND eo.qamf_web_offer_id IN (156, 120)
  `;
  await q`
    UPDATE bowling_experience_offers eo
    SET qamf_web_offer_id = CASE
          WHEN eo.qamf_web_offer_id = 157 THEN 155
          WHEN eo.qamf_web_offer_id = 121 THEN 119
        END,
        qamf_option_type = 'Time',
        qamf_option_id = CASE
          WHEN eo.center_code = 'TXBSQN0FEKQ11' THEN 1235
          WHEN eo.center_code = 'PPTR5G2N0QXF7' THEN 947
        END
    FROM bowling_experiences e
    WHERE e.id = eo.experience_id
      AND e.slug = 'fun-4-all-vip'
      AND eo.qamf_web_offer_id IN (157, 121)
  `;

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
  // Customer-account lookups (getReservationsByContact). guest_phone is stored
  // in mixed historical formats, so we index the normalized last-10-digits to
  // match the predicate exactly (no seq scan). guest_email is lower-cased.
  await q`CREATE INDEX IF NOT EXISTS br_guest_phone10 ON bowling_reservations(right(regexp_replace(guest_phone,'\\D','','g'),10)) WHERE guest_phone IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS br_guest_email_lc ON bowling_reservations(lower(guest_email)) WHERE guest_email IS NOT NULL`;

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
  // Reconcile index for race/attraction confirm recovery (race-confirm-reconcile cron).
  await q`CREATE INDEX IF NOT EXISTS br_bmi_confirm_pending ON bowling_reservations(inserted_at) WHERE status IN ('confirm_pending', 'confirm_failed')`;

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

  // Coupon / discount code applied at booking (e.g. "USA250") + the pre-tax
  // cents it removed from this reservation's charge. Covers BOTH mechanisms
  // (price-key promo and order-level Square catalog discount) — the guest sees
  // one "coupon". Recorded for the admin board + reporting; the authoritative
  // usage ledger stays discount_redemptions.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS promo_code TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS promo_savings_cents INT NOT NULL DEFAULT 0`;

  // Attraction add-ons booked via BMI during the bowling wizard.
  // JSON array of { slug, name, bmiOrderId, bmiBillLineId, quantity, totalPriceDollars, timeSlot, timeLabel }.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS attraction_bookings JSONB NOT NULL DEFAULT '[]'`;

  // Check-in method: 'self' (kiosk/self-service) or 'desk' (front desk staff).
  // Set by admin board; NULL = not yet checked in.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS checkin_method TEXT`;
  // WHEN they checked in, as opposed to which way. `checkin_method` has always been a
  // method with no moment attached, so "checked in within the last half hour" — what the
  // front-desk wall shows (owner 2026-09-01) — could only be approximated from the booked
  // SLOT, which is a different thing entirely and drifts from it by however long a guest
  // was early or late. Backfills as NULL: those rows simply do not appear on that board,
  // which is the honest answer, and it self-heals on the next check-in.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ`;

  // Loyalty action during booking: 'signup' (new account), 'existing' (logged in),
  // or NULL (no loyalty interaction). Redemption tracked separately via
  // square_loyalty_reward_id + reward_discount_cents.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS loyalty_action TEXT`;

  // ── v2 booking metadata (PR-B3.5) ─────────────────────────────────
  // JSONB column for type-specific metadata. Races store heat assignments
  // + racer names. Attractions store slug + time slot + quantity. Bowling
  // doesn't use it (has its own player/line tables).
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS booking_metadata JSONB`;

  // ── Combo special linkage (Ultimate VIP Experience) ──────────────
  // A combo books as TWO rows (a `race` leg + an `open` bowling leg) that
  // share one square_deposit_order_id (+ gift card); since the order split
  // each leg settles its OWN square_dayof_order_id (older pre-split rows
  // shared one). Neither product_kind says "VIP", so we stamp the combo id
  // (e.g. 'race-bowl') on BOTH legs at insert time. This is the ONLY
  // queryable VIP marker — the rest lives in Redis / BMI memo. Lets the
  // reservations portal filter + group VIP combos across centers.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS combo_special_id TEXT`;
  await q`CREATE INDEX IF NOT EXISTS br_combo ON bowling_reservations(combo_special_id) WHERE combo_special_id IS NOT NULL`;

  // ── End-of-session order completion (bowling-order-complete cron) ──
  // Lane-open intentionally leaves the day-of order OPEN with its SHIPMENT
  // fulfillment so the kitchen/KDS keeps showing shoe sizes + food during the
  // session. Once the session is well over, the bowling-order-complete cron
  // completes the fulfillment + order so it imports into QuickBooks as a closed
  // sale. This stamps the time we did so — the idempotency guard so each run
  // only looks at orders not yet completed by us.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS dayof_order_completed_at TIMESTAMPTZ`;
  await q`CREATE INDEX IF NOT EXISTS br_order_complete_pending ON bowling_reservations(booked_at)
          WHERE dayof_order_completed_at IS NULL AND checkin_method IS NOT NULL AND combo_special_id IS NULL`;

  // ── Cancellation outcome + store-credit tracking ──────────────────
  // A cancellation settles one of two ways: 'refund' (card refund via
  // /v2/refunds) or 'store_credit' (deposit converted into a NEW customer
  // gift card — Square-generated GAN, never the internal WEBHPFM… deposit
  // card). 'none' = nothing was charged ($0/credit rows). The store-credit
  // card id/GAN are persisted BEFORE delivery is attempted so a failed
  // email/SMS can never lose the card — the portal reads them off the row.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS cancellation_outcome TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS cancelled_by TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS store_credit_gift_card_id TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS store_credit_gift_card_gan TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS store_credit_cents INTEGER NOT NULL DEFAULT 0`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS store_credit_state TEXT`;
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS cancel_notified_at TIMESTAMPTZ`;

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
  /** Modifier picks included per group before `extraModifierCents` applies. */
  includedModifierCount: number;
  /** Charge per pick beyond `includedModifierCount`. 0 = extras not offered. */
  extraModifierCents: number;
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
  /** Fixed duration (minutes) of the offer-level option — Pizza Bowl 120,
   *  Fun 4 All 90, World Cup 150. Null for Game/Unlimited and hourly offers
   *  (hourly durations live in durationOptions). Duration source of truth:
   *  our DB, never QAMF's Minutes field. */
  qamfOfferDurationMinutes: number | null;
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

export type ReservationProductKind = "kbf" | "open" | "race" | "attraction";

export interface BowlingReservation {
  id: number;
  centerCode: string;
  productKind: ReservationProductKind;
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
    | "no_show"
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
  /**
   * How the cancellation settled: 'refund' (card refund), 'store_credit'
   * (deposit converted to a new customer gift card), or 'none' ($0 rows —
   * nothing was charged). Undefined on rows cancelled before this existed.
   */
  cancellationOutcome?: "refund" | "store_credit" | "none";
  /** Who triggered the cancellation: guest self-serve or staff portal. */
  cancelledBy?: "customer" | "admin";
  /** Store-credit gift card issued on cancellation (Square-generated GAN, NOT the internal deposit card). */
  storeCreditGiftCardId?: string;
  /** The store-credit card's GAN — shown to staff on the cancelled row + sent to the guest. */
  storeCreditGiftCardGan?: string;
  /** Amount loaded onto the store-credit card (cents). 0 = no store credit issued. */
  storeCreditCents: number;
  /** 'issuing' = persisted before activation completed; 'issued' = verified ACTIVE. */
  storeCreditState?: "issuing" | "issued";
  /** ISO timestamp when the cancellation email/SMS went out. Null = not (yet) notified. */
  cancelNotifiedAt?: string;
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
  /** Coupon / discount code applied at booking (e.g. "USA250"). Undefined = none. */
  promoCode?: string;
  /** Pre-tax cents the coupon removed from THIS reservation's charge. */
  promoSavingsCents: number;
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
  /** Type-specific metadata (race heats, attraction details). Null for bowling. */
  bookingMetadata?: Record<string, unknown>;
  /**
   * Combo special id (e.g. 'race-bowl' = Ultimate VIP Experience) when this row
   * is one leg of a combo. Stamped on BOTH the race leg and the bowling leg,
   * which share a square_dayof_order_id. Undefined for ordinary reservations.
   */
  comboSpecialId?: string;
  /**
   * The real EVENT time as a naive ET wall-clock ISO ("2026-06-15T13:30:00"):
   * the earliest race heat / attraction slot, or booked_at for bowling/KBF.
   * Computed by the list queries — the board should display & sort on this, not
   * booked_at (which is the booking timestamp for race/attraction anchors).
   * Undefined when fetched by a path that doesn't compute it.
   */
  eventAt?: string;
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
    productKind: row.product_kind as ReservationProductKind,
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
    cancellationOutcome:
      (row.cancellation_outcome as BowlingReservation["cancellationOutcome"]) ?? undefined,
    cancelledBy: (row.cancelled_by as BowlingReservation["cancelledBy"]) ?? undefined,
    storeCreditGiftCardId: (row.store_credit_gift_card_id as string) ?? undefined,
    storeCreditGiftCardGan: (row.store_credit_gift_card_gan as string) ?? undefined,
    storeCreditCents: (row.store_credit_cents as number) ?? 0,
    storeCreditState:
      (row.store_credit_state as BowlingReservation["storeCreditState"]) ?? undefined,
    cancelNotifiedAt: row.cancel_notified_at
      ? (row.cancel_notified_at as Date).toISOString()
      : undefined,
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
    promoCode: (row.promo_code as string) ?? undefined,
    promoSavingsCents: (row.promo_savings_cents as number) ?? 0,
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
    bookingMetadata: (() => {
      const raw = row.booking_metadata;
      if (!raw) return undefined;
      if (typeof raw === "string")
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      if (typeof raw === "object") return raw as Record<string, unknown>;
      return undefined;
    })(),
    comboSpecialId: (row.combo_special_id as string) ?? undefined,
    eventAt: (row.event_at as string) ?? undefined,
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
    | "promoSavingsCents"
    | "attractionBookings"
    | "checkinMethod"
    | "bookingMetadata"
    | "cancellationOutcome"
    | "cancelledBy"
    | "storeCreditGiftCardId"
    | "storeCreditGiftCardGan"
    | "storeCreditCents"
    | "storeCreditState"
    | "cancelNotifiedAt"
  > & {
    rewardDiscountCents?: number;
    promoSavingsCents?: number;
    attractionBookings?: BowlingReservation["attractionBookings"];
    bookingMetadata?: Record<string, unknown>;
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
      promo_code, promo_savings_cents,
      loyalty_action, attraction_bookings, booking_metadata, combo_special_id
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
      ${r.promoCode ?? null}, ${r.promoSavingsCents ?? 0},
      ${r.loyaltyAction ?? null}, ${JSON.stringify(r.attractionBookings ?? [])}::jsonb,
      ${r.bookingMetadata ? JSON.stringify(r.bookingMetadata) : null}::jsonb,
      ${r.comboSpecialId ?? null}
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

/**
 * Stamp a coupon (code + pre-tax savings cents) onto a reservation row for the
 * admin board. No-ops if the row already carries a code (insert-time stamp wins).
 */
export async function setBowlingReservationPromo(
  id: number,
  code: string,
  savingsCents: number,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET promo_code = ${code}, promo_savings_cents = ${savingsCents}
    WHERE id = ${id} AND promo_code IS NULL
  `;
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
 * Look up the most recent reservation for a BMI bill id (race/attraction lines
 * live on the shared BMI bill). Used by the admin inspector to correlate a
 * billId → gift card + day-of order + center. Returns the reservation row
 * (without lines); the `br_bmi` index keeps it cheap.
 */
export async function getBowlingReservationByBillId(
  bmiBillId: string,
): Promise<BowlingReservation | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations WHERE bmi_bill_id = ${bmiBillId} ORDER BY id DESC LIMIT 1
  `;
  if (!rows.length) return null;
  return rowToReservation(rows[0] as Record<string, unknown>);
}

/**
 * Combo sibling legs (Ultimate VIP): the OTHER reservation row(s) from the same
 * combo checkout. Post-split combos write TWO rows (race @ FastTrax + bowling @
 * HeadPinz) with DIFFERENT day-of orders; the one key that survives the split is
 * square_deposit_order_id — one deposit charge for the whole cart (br_dep_sq
 * index). combo_special_id must MATCH so a plain mixed cart, which also shares
 * one deposit order across rows, never pairs here.
 */
export async function listComboSiblingReservations(
  depositOrderId: string,
  comboSpecialId: string,
  excludeId: number,
): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE square_deposit_order_id = ${depositOrderId}
      AND combo_special_id = ${comboSpecialId}
      AND id != ${excludeId}
      AND status != 'cancelled'
    ORDER BY id
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * The MONEY GROUP a cancellation must operate on: every reservation row that
 * shares the anchor's deposit charge. One deposit order funds one internal
 * gift card, so refunding/converting it for half a group is impossible —
 * combo legs (race + bowling) AND mixed carts (race + attraction rows on one
 * bill) cancel together. Grouping key: square_deposit_order_id when charged;
 * bmi_bill_id for $0/credit rows; the anchor alone otherwise.
 *
 * Deliberately does NOT filter status: already-cancelled legs are returned so
 * the cascade can (a) short-circuit when the WHOLE group is cancelled and
 * (b) repair legacy partial cancels (the old combo bug) by skipping done legs.
 */
export async function listCancelGroupReservations(
  anchor: BowlingReservation,
): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [anchor];
  await ensureBowlingSchema();
  const q = sql();
  if (anchor.squareDepositOrderId) {
    const rows = await q`
      SELECT * FROM bowling_reservations
      WHERE square_deposit_order_id = ${anchor.squareDepositOrderId}
      ORDER BY id
    `;
    return rows.map((r) => rowToReservation(r as Record<string, unknown>));
  }
  if (anchor.bmiBillId) {
    const rows = await q`
      SELECT * FROM bowling_reservations
      WHERE bmi_bill_id = ${anchor.bmiBillId}
      ORDER BY id
    `;
    return rows.map((r) => rowToReservation(r as Record<string, unknown>));
  }
  return [anchor];
}

/**
 * Reserve-path anchor idempotency: the existing non-cancelled reservation for a
 * (bill, productKind), so a double-submit / retry REUSES the row instead of
 * inserting a duplicate. Scoped by product_kind because race + attraction
 * legitimately share one BMI bill (one row each) — never key on bill alone.
 */
export async function findReusableReservation(
  bmiBillId: string,
  productKind: string,
): Promise<BowlingReservation | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE bmi_bill_id = ${bmiBillId}
      AND product_kind = ${productKind}
      AND status != 'cancelled'
    ORDER BY id DESC LIMIT 1
  `;
  if (!rows.length) return null;
  return rowToReservation(rows[0] as Record<string, unknown>);
}

/**
 * Race reservations awaiting day-of settlement: confirmed, on the $0 model (gift
 * card + day-of order present), and not yet settled (dayof_order_sent_at NULL).
 * The race-dayof-pay cron cross-references these against BMI "Arrived" projects,
 * then charges the gift card against the open day-of order. Naturally a small
 * set (only unpaid races awaiting check-in), so no date window needed.
 *
 * Excludes races whose day-of order is SHARED with a bowling/KBF reservation
 * (combo specials: race + bowling in one session = one Square order). For those,
 * LANE-OPEN settles the combined order — same NOT EXISTS guard as the attraction
 * query below. Never auto-settle bowling at race start: the bowling value would
 * be charged before lanes open (and any attached food fired to the kitchen).
 * A racer who skips bowling leaves the order for auto-close/manual settle —
 * accepted in tasks/combo-specials-plan.md (locked decision #6).
 */
export async function getRaceReservationsAwaitingDayofPay(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT r.* FROM bowling_reservations r
    WHERE r.product_kind = 'race'
      AND r.status = 'confirmed'
      AND r.dayof_order_sent_at IS NULL
      -- Funded ($-model w/ gift card) OR $0-model (no gift card, paid in full at
      -- booking). The $0 ones have no gift card to charge — chargeDayof just
      -- COMPLETES their already-$0 order so they don't sit "Pending" forever.
      AND (r.square_gift_card_id IS NOT NULL OR r.total_cents = 0)
      AND r.square_dayof_order_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM bowling_reservations b
        WHERE b.square_dayof_order_id = r.square_dayof_order_id
          AND b.product_kind IN ('open', 'kbf')
      )
    ORDER BY r.booked_at DESC
    LIMIT 500
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * Confirmed RACE reservations whose racers may still need checking into their
 * Pandora race session — the candidate set for the race-session-assign-sweep
 * cron. Bounded to near-term heats (booked_at within a wide day-of window) so
 * the re-POST is cheap and self-terminating: once a heat ages past the window
 * the row drops out. Only rows carrying a reservation number + persisted heat
 * metadata are returnable (the sweep rebuilds racers from booking_metadata.heats
 * and posts to /bmi/schedule by reservation number). The sweep further skips any
 * reservation already flagged done in Redis, so a healthy booking is re-checked
 * at most once.
 */
export async function getRecentConfirmedRaceReservationsForAssign(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT r.* FROM bowling_reservations r
    WHERE r.product_kind = 'race'
      AND r.status = 'confirmed'
      AND r.bmi_reservation_number IS NOT NULL
      AND r.booking_metadata IS NOT NULL
      AND r.booked_at > NOW() - INTERVAL '6 hours'
      AND r.booked_at < NOW() + INTERVAL '18 hours'
    ORDER BY r.booked_at ASC
    LIMIT 500
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * Standalone-attraction reservations awaiting day-of settlement: confirmed,
 * unpaid, with a gift card + open day-of order, AND with NO bowling/KBF
 * reservation sharing the same day-of order. When bowling IS in the session the
 * lane-open flow settles the combined order, so we must NOT also settle from the
 * attraction side — hence the NOT EXISTS guard. The day-of pay cron polls these
 * like races (BMI check-in -5 + start-time-passed fallback).
 */
export async function getAttractionReservationsAwaitingDayofPay(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT r.* FROM bowling_reservations r
    WHERE r.product_kind = 'attraction'
      AND r.status = 'confirmed'
      AND r.dayof_order_sent_at IS NULL
      -- Funded (gift card) OR $0-model (paid in full at booking, no gift card);
      -- chargeDayof COMPLETES the $0 ones so they don't sit "Pending".
      AND (r.square_gift_card_id IS NOT NULL OR r.total_cents = 0)
      AND r.square_dayof_order_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM bowling_reservations b
        WHERE b.square_dayof_order_id = r.square_dayof_order_id
          AND b.product_kind IN ('open', 'kbf')
      )
    ORDER BY r.booked_at DESC
    LIMIT 500
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * No-show bowling/KBF reservations to close at end of night: a past slot that
 * was NEVER checked in (status still 'confirmed', no checkin_method), with an
 * open day-of order. The bowling-no-show-close cron settles these by applying
 * the prepaid gift card to the order and COMPLETING it WITHOUT a fulfillment —
 * so the no-show's deposit is collected but the KDS/kitchen never fires (that's
 * the lane-open-only step). Combo legs are excluded (they settle via their own
 * combined-order flow). booked_at IS the lane slot for bowling, so a 2-hour
 * buffer guarantees the session has ended before we close it.
 */
export async function getNoShowBowlingReservations(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE product_kind IN ('open', 'kbf')
      -- 'no_show' included: the status-close cron flips never-checked-in past
      -- bowling to no_show for visibility BEFORE this nightly money settle runs.
      AND status IN ('confirmed', 'no_show')
      AND checkin_method IS NULL
      AND dayof_order_sent_at IS NULL
      AND square_dayof_order_id IS NOT NULL
      AND combo_special_id IS NULL
      AND booked_at < NOW() - INTERVAL '2 hours'
    ORDER BY booked_at ASC
    LIMIT 500
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * Checked-in bowling/KBF reservations whose day-of Square order should now be
 * COMPLETED. Lane-open leaves the order OPEN (fully paid, $0 due) with its
 * SHIPMENT fulfillment so the KDS keeps showing the order during the session.
 * Once the session is well over we complete the fulfillment + order so it
 * imports into QuickBooks as a closed sale (see bowling-order-complete cron).
 *
 * Population: lane-open ran (gift card charged, order sent to Square, fulfillment
 * present) — keyed off (dayof_order_sent_at IS NOT NULL OR checkin_method IS NOT
 * NULL). dayof_order_sent_at is the primary signal: updateBowlingReservationLaneOpen
 * stamps it on a successful lane-open via the QAMF webhook/poll path, which is how
 * most open bowling opens — that path does NOT record checkin_method (only the
 * explicit check-in UI does), so a checkin_method-only filter missed every
 * webhook-opened paid order and left it OPEN (the 2026-06-16 recurrence; see
 * postmortem). This matches the same `sent` predicate closePastReservationStatuses
 * uses to flip these to status='completed'. Session ended (3h buffer — larger than
 * the no-show 2h buffer so even a long session's food ticket is done before we drop
 * it from KDS), and not yet completed by us. Combo bowling legs ARE included
 * (2026-07-08): the promised combo "own settle flow" never materialized, so paid
 * legs sat OPEN forever (45 found in the portal's 7/8 sweep) — they pay at
 * lane-open exactly like regular bowling, so they complete the same way. The
 * completeOrder() safety net still re-checks state=OPEN + $0-due before closing, so
 * a sent-but-unpaid order is skipped (left to surface/retry), never force-closed.
 * No-shows (never lane-opened) are handled by bowling-no-show-close — which still
 * EXCLUDES combos (charging a combo no-show's shared gift card stays manual).
 */
/**
 * The booking sources whose guests can actually self check in.
 *
 * `web` and `kiosk` are OUR OWN surfaces: a person chose a time, paid, and has not yet
 * been met by anybody. The other two are not guests waiting to be served —
 *
 *   `conqueror`  the front-desk POS. This is where leagues, school groups and LANE
 *                CLOSURES live: at HeadPinz FM it holds 5,883 rows of which 1,851 have
 *                a blank guest name, 33 are literally named some casing of "closed",
 *                and many are forward-dated into 2027. It is also where a staff member
 *                books a guest who is standing in front of them — already served, so
 *                nothing to prompt.
 *   `admin`      the staff KBF admin tool.
 *
 * FILTERED ON THE SOURCE, NOT ON THE NAME. Name-matching was the obvious idea and it
 * does not work: "closed" appears as closed/Closed/CLOSED, 1,851 rows have no name to
 * match against at all, and the next convention staff invent slips straight through.
 * `booking_source` is structural — every row has one, with no nulls anywhere in the
 * table — so it cannot be defeated by how somebody types.
 *
 * The CHECKED-IN half deliberately does NOT filter this way: a self check-in is itself
 * proof of a real guest (that column is 100% web+kiosk in the data already), and if a
 * desk-booked party ever does use a kiosk they still need to be told their lane.
 */
const SELF_CHECKIN_SOURCES = ["web", "kiosk"] as const;

/**
 * Reservations the lane-ready cron should ASK QAMF about: due within the window, not yet
 * checked in, and bookable through a surface a guest can check in from.
 *
 * Deliberately narrow, because each one costs a vendor call. Outside trading hours it
 * returns nothing and the cron makes no QAMF requests at all, which is why an
 * every-minute job is affordable here.
 *
 * `withinMins` should be the self-service window plus a little slack — a reservation that
 * has only just crossed into the window still wants its first poll promptly, and a guest
 * running late still wants the board to keep listing them.
 */
export async function getBowlingReservationsToPollForLane(
  centerCode: string,
  withinMins = 35,
  lateGraceMins = 90,
): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE center_code = ${centerCode}
      AND checkin_method IS NULL
      AND status IN ('confirmed', 'arrived')
      AND product_kind IN ('open', 'kbf')
      AND booking_source = ANY(${[...SELF_CHECKIN_SOURCES]})
      AND TRIM(COALESCE(guest_name, '')) <> ''
      AND qamf_reservation_id IS NOT NULL
      AND qamf_reservation_id <> ''
      AND booked_at BETWEEN NOW() - (${lateGraceMins} * INTERVAL '1 minute')
                        AND NOW() + (${withinMins} * INTERVAL '1 minute')
    ORDER BY booked_at ASC
    LIMIT 40
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * Reservations that could check themselves in RIGHT NOW — due about now, and nobody
 * has checked them in yet.
 *
 * The other half of the front-desk wall's left panel. On its own the "checked in" list
 * only ever speaks to people who have already worked out what to do; this is the half
 * that tells a guest walking through the door that they are expected and can go
 * straight to a kiosk instead of queueing at the desk.
 *
 * `checkin_method IS NULL` is the whole definition of "not yet": it is set by both the
 * kiosk and the desk, so a party the desk has already handled drops off this list
 * without needing a second flag.
 *
 * THE WINDOW IS DELIBERATELY WIDER BEFORE THAN AFTER. Guests arrive early far more
 * often than a reservation is genuinely still checkable an hour late, and the
 * pre-arrival notice already goes out ~30 minutes ahead — so someone who got that text
 * and walked straight over should see themselves listed. An hour and a half afterwards
 * covers a late party without carrying no-shows all evening; `closePastReservationStatuses`
 * eventually flips those to no_show anyway.
 */
export async function getSelfCheckinEligible(
  centerCode: string,
  limit = 8,
): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE center_code = ${centerCode}
      AND checkin_method IS NULL
      AND status IN ('confirmed', 'arrived')
      AND product_kind IN ('open', 'kbf')
      AND booking_source = ANY(${[...SELF_CHECKIN_SOURCES]})
      -- A row with no name cannot render on the wall anyway (the feed reduces to a
      -- first name and drops the blanks), but excluding it here keeps the LIMIT
      -- spending its slots on rows that will actually appear.
      AND TRIM(COALESCE(guest_name, '')) <> ''
      -- THE NEXT HOUR, plus a half-hour grace for a late arrival (owner 2026-09-01:
      -- "showing reservations within next hour"). Ordered soonest-first so the top of
      -- the board is whoever is due next.
      AND booked_at BETWEEN NOW() - INTERVAL '30 minutes' AND NOW() + INTERVAL '60 minutes'
    ORDER BY booked_at ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * Everyone who SELF-checked in today and has a lane, newest first.
 *
 * Drives the front-desk wall's left panel: a guest who checked themselves in at a
 * kiosk was never told a lane number by a person, so the wall is the only place
 * they learn it. `checkin_method = 'self'` is the whole point — a DESK check-in
 * already had a human say it out loud, and listing those would pad the board with
 * people who do not need it.
 *
 * `dayof_order_lane` is only populated when lanes actually OPENED, which is exactly
 * the moment there is something true to display. Rows without it are excluded rather
 * than shown as pending: "checked in, lane coming" is a promise the board cannot
 * keep, and an empty lane column reads as a fault.
 *
 * THE LAST THIRTY MINUTES OF CHECK-INS, and windowed on when they CHECKED IN rather
 * than on the slot they booked (owner 2026-09-01: "checked in should only show lanes
 * checked in last 30 minutes").
 *
 * It was six hours on `booked_at`, which is a very different board from the one it looks
 * like. Probed live at 02:05 it was still naming guests booked at 20:30 and 21:30 —
 * people who had finished and left — holding every visible row against anyone actually
 * arriving. And `booked_at` is the SLOT, so even a tight window on it would drift from
 * the moment a guest walked in by however early or late they were. `checked_in_at` is
 * the real thing, added for this.
 *
 * Rows checked in before that column existed have NULL and do not appear, which is the
 * honest answer to "when did they check in" rather than a guess — it self-heals with the
 * first check-in after deploy.
 */
export async function getSelfCheckedInWithLanes(
  centerCode: string,
  limit = 8,
): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE center_code = ${centerCode}
      AND checkin_method = 'self'
      AND dayof_order_lane IS NOT NULL
      AND dayof_order_lane <> ''
      AND status NOT IN ('cancelled', 'no_show')
      AND checked_in_at > NOW() - INTERVAL '30 minutes'
    ORDER BY checked_in_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

export async function getCheckedInOrdersToComplete(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE product_kind IN ('open', 'kbf')
      AND (dayof_order_sent_at IS NOT NULL OR checkin_method IS NOT NULL)
      AND status NOT IN ('cancelled')
      AND square_dayof_order_id IS NOT NULL
      AND square_dayof_order_id <> ''
      AND dayof_order_completed_at IS NULL
      AND booked_at < NOW() - INTERVAL '3 hours'
    ORDER BY booked_at ASC
    LIMIT 500
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * Stamp dayof_order_completed_at = NOW() once the day-of Square order has been
 * COMPLETED (or found already terminal). The idempotency guard for
 * getCheckedInOrdersToComplete — once set, the row drops out of future runs.
 */
export async function markDayofOrderCompleted(id: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`UPDATE bowling_reservations SET dayof_order_completed_at = NOW() WHERE id = ${id}`;
}

/**
 * End-of-night status close: flip PAST-event reservations that are still in a
 * non-terminal status to a terminal one, so "Active Only" (which hides
 * completed/no_show/cancelled) stops showing yesterday's leftovers. Visibility
 * only — money settlement is owned by the settle crons (bowling-no-show-close,
 * race-dayof-pay); this runs AFTER them.
 *
 * Per past-event reservation (event time from booking_metadata heat/slot, else
 * booked_at):
 *   - showed/settled → completed. Settled = arrived | checkin_method |
 *     dayof_order_sent_at | a SIBLING sharing the same day-of order is settled.
 *     The sibling case closes the attraction / 2nd leg of a combined checkout,
 *     whose own row never gets sent/checkin (the bowling leg's lane-open settled
 *     the shared order). COMBOS are included in this completed-flip (their orders
 *     settle at deposit, so post-event this is a visibility-only flip) — without
 *     it, combo racing/bowling legs lingered on the board indefinitely.
 *   - never-shown + unsettled + nothing to collect (no gift card OR $0) → no_show
 *   - never-shown + unsettled + funded (gift card + money) → LEFT untouched so
 *     the settle crons charge it first; the next run then flips it (completed).
 * no_show / pendingSettle stay money-sensitive: combos and rows with a settled
 * sibling are NEVER flipped to no_show. confirm_failed / confirm_pending are LEFT
 * (real issues that should surface).
 */
export async function closePastReservationStatuses(
  opts: { dryRun?: boolean } = {},
): Promise<{ completed: number; noShow: number; pendingSettle: number }> {
  if (!isDbConfigured()) return { completed: 0, noShow: 0, pendingSettle: 0 };
  await ensureBowlingSchema();
  const q = sql();
  // Flip once the event's actual TIME has passed (2h buffer = session ended),
  // not just whole past days — so TODAY's already-finished slots flip intra-day
  // instead of lingering until tomorrow. cutoff = (now − 2h) as a naive ET
  // wall-clock ISO; event_at is the same shape, so a lexical compare is
  // chronological.
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T");
  const rows = (await q`
    SELECT b.id, b.product_kind pk, b.status, b.checkin_method ci,
           (b.dayof_order_sent_at IS NOT NULL) sent,
           (b.combo_special_id IS NOT NULL) is_combo,
           EXISTS (
             SELECT 1 FROM bowling_reservations s
             WHERE s.square_dayof_order_id = b.square_dayof_order_id
               AND s.square_dayof_order_id IS NOT NULL AND s.square_dayof_order_id <> ''
               AND s.id <> b.id
               AND (s.checkin_method IS NOT NULL OR s.dayof_order_sent_at IS NOT NULL
                    OR s.status IN ('arrived', 'completed'))
           ) AS sibling_settled,
           COALESCE(
             (SELECT min(t.e->>'heatId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.booking_metadata->'heats')='array' THEN b.booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)),
             (SELECT min(t.e->>'slot')   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.booking_metadata->'attractions')='array' THEN b.booking_metadata->'attractions' ELSE '[]'::jsonb END) AS t(e)),
             to_char(b.booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD"T"HH24:MI:SS')
           ) AS event_at
    FROM bowling_reservations b
    WHERE b.status IN ('confirmed', 'arrived')
  `) as Array<Record<string, unknown>>;
  const past = rows.filter((r) => String(r.event_at) < cutoff);
  // Showed up or already settled → completed (see doc comment). sibling_settled
  // closes the attraction/2nd leg of a combined checkout; combos are included.
  const toCompleted = past
    .filter(
      (r) =>
        r.status === "arrived" || r.ci != null || r.sent === true || r.sibling_settled === true,
    )
    .map((r) => r.id as number);
  // Bowling/KBF that was never checked in and not settled → no_show NOW
  // (visibility), regardless of whether it's funded. The money is decoupled:
  // bowling-no-show-close (which also queries 'no_show') charges the funded ones
  // at end of night. Races/attractions are NOT flipped here — race-dayof-pay
  // settles them within minutes, after which they land in toCompleted above.
  const toNoShow = past
    .filter(
      (r) =>
        r.status === "confirmed" &&
        r.ci == null &&
        r.sent !== true &&
        r.sibling_settled !== true &&
        r.is_combo !== true &&
        (r.pk === "open" || r.pk === "kbf"),
    )
    .map((r) => r.id as number);
  // Past, unsettled race/attraction awaiting their (fast) settle cron. Combos and
  // sibling-settled rows are excluded — they're handled by toCompleted above.
  const pendingSettle = past.filter(
    (r) =>
      r.status === "confirmed" &&
      r.ci == null &&
      r.sent !== true &&
      r.sibling_settled !== true &&
      r.is_combo !== true &&
      r.pk !== "open" &&
      r.pk !== "kbf",
  ).length;

  if (!opts.dryRun) {
    if (toCompleted.length)
      await q`UPDATE bowling_reservations SET status = 'completed' WHERE id = ANY(${toCompleted})`;
    if (toNoShow.length)
      await q`UPDATE bowling_reservations SET status = 'no_show' WHERE id = ANY(${toNoShow})`;
  }
  return { completed: toCompleted.length, noShow: toNoShow.length, pendingSettle };
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
 * Bulk lookup: given a list of bowling_reservations IDs (as strings or
 * numbers), return a Map keyed by stringified ID → reservation row.
 * Designed for the survey-list portal endpoint that needs to attach
 * lane / time / Square-order context to each survey result.
 *
 * No lines join — keeps the payload light. Caller can hit
 * `getBowlingReservation(id)` if they need line items per row.
 */
export async function getBowlingReservationsByIds(
  ids: Array<string | number>,
): Promise<Map<string, BowlingReservation>> {
  const out = new Map<string, BowlingReservation>();
  if (!isDbConfigured() || ids.length === 0) return out;
  await ensureBowlingSchema();
  const q = sql();
  // Coerce to number[] — bowling_reservations.id is bigint. Skip
  // anything non-numeric (e.g. admin-test-* origin_refs).
  const numericIds = ids.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
  if (numericIds.length === 0) return out;
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE id = ANY(${numericIds}::bigint[])
  `;
  for (const r of rows as Array<Record<string, unknown>>) {
    const res = rowToReservation(r);
    out.set(String(res.id), res);
  }
  return out;
}

/**
 * List bowling reservations filtered by booked_at date range.
 * Used by the admin reservations board. Includes order lines.
 */
export async function listBowlingReservations(opts: {
  startDate: string; // 'YYYY-MM-DD' inclusive
  endDate: string; // 'YYYY-MM-DD' inclusive
  centerCode?: string;
  /** Match any of several center_code values. Needed because center_code holds
   *  two namespaces today (Square location IDs for bowling, slugs for
   *  race/attraction) — one logical center can span both. Takes precedence over
   *  `centerCode` when provided. See tasks/future/center-code-normalization.md. */
  centerCodes?: string[];
  productKinds?: ReservationProductKind[];
}): Promise<BowlingReservationWithLines[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const centerCodes = opts.centerCodes ?? (opts.centerCode ? [opts.centerCode] : undefined);
  const hasCenter = !!centerCodes && centerCodes.length > 0;
  const hasKinds = !!opts.productKinds && opts.productKinds.length > 0;

  // Filter / sort / display by the EVENT time, not booked_at. For race &
  // attraction rows, booked_at is the BOOKING timestamp (when the guest paid),
  // so a race booked today for next month would otherwise show up on today's
  // board looking overdue. The real activity time lives in booking_metadata:
  // race HEATS (heatId) or attraction SLOTS (slot) — both naive ET wall-clock
  // ISO ("2026-06-15T13:30:00"). Bowling/KBF have no such metadata and fall back
  // to booked_at (which IS their lane slot). event_at is a naive ET ISO; we
  // date-filter on its first 10 chars (lexical compare == chronological for
  // ISO), which also sidesteps the ::date param-hint pitfall the neon tag has.
  const centerCond = hasCenter ? q`AND s.center_code = ANY(${centerCodes!}::text[])` : q``;
  const kindCond = hasKinds ? q`AND s.product_kind = ANY(${opts.productKinds!}::text[])` : q``;
  const rows = await q`
    SELECT * FROM (
      SELECT *,
        COALESCE(
          (SELECT min(t.e->>'heatId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'heats')='array' THEN booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)),
          (SELECT min(t.e->>'slot')   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'attractions')='array' THEN booking_metadata->'attractions' ELSE '[]'::jsonb END) AS t(e)),
          to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD"T"HH24:MI:SS')
        ) AS event_at
      FROM bowling_reservations
    ) s
    WHERE left(s.event_at, 10) >= ${opts.startDate}
      AND left(s.event_at, 10) <= ${opts.endDate}
      ${centerCond}
      ${kindCond}
    ORDER BY s.event_at ASC
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

/**
 * List VIP combo legs for a date range — rows with combo_special_id set,
 * across ALL centers (combos span FastTrax racing + HeadPinz bowling, so the
 * reservations portal surfaces them regardless of the center it's scoped to).
 * Returns each leg with its lines; the caller groups by square_dayof_order_id.
 */
export async function listVipComboReservations(opts: {
  startDate: string; // 'YYYY-MM-DD' inclusive
  endDate: string; // 'YYYY-MM-DD' inclusive
}): Promise<BowlingReservationWithLines[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  // Filter by EVENT date (heat/slot time), not booked_at — so a combo whose
  // race leg was booked days before the event still surfaces on the event date,
  // and BOTH legs (race heat date + bowling slot date, which match) come back
  // together. See listBowlingReservations for the event_at rationale.
  const rows = await q`
    SELECT * FROM (
      SELECT *,
        COALESCE(
          (SELECT min(t.e->>'heatId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'heats')='array' THEN booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)),
          (SELECT min(t.e->>'slot')   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'attractions')='array' THEN booking_metadata->'attractions' ELSE '[]'::jsonb END) AS t(e)),
          to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD"T"HH24:MI:SS')
        ) AS event_at
      FROM bowling_reservations
      WHERE combo_special_id IS NOT NULL
    ) s
    WHERE left(s.event_at, 10) >= ${opts.startDate}
      AND left(s.event_at, 10) <= ${opts.endDate}
    ORDER BY s.event_at ASC
  `;
  const reservations = rows.map((r) => rowToReservation(r as Record<string, unknown>));
  if (!reservations.length) return [];

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
  return reservations.map((r) => ({ ...r, lines: linesByRes.get(r.id) ?? [] }));
}

/** One already-booked heat with racer identity — cross-reservation spacing signal. */
export interface BookedRaceHeatRow {
  heatId: string;
  track: string | null;
  /** BMI personId as a STRING (never Number() a BMI id). */
  bmiPersonId: string;
  racer: string | null;
}

/**
 * Every heat already booked for any of `personIds` on `date` — the signal for
 * cross-reservation spacing enforcement (conflict.ts findCrossBookingConflict).
 * Reads booking_metadata.heats[].bmiPersonId, persisted at reserve time since
 * 2026-07-02; older rows lack the field and simply never match (forward-only
 * per owner). Active reservations only. `excludeBillId` drops the caller's own
 * bill so a reserve retry (confirm_pending anchor already written) never
 * self-conflicts.
 */
export async function raceHeatsForPersonsOnDate(opts: {
  /** Center-local date the heats start on, "YYYY-MM-DD". */
  date: string;
  personIds: string[];
  excludeBillId?: string | null;
}): Promise<BookedRaceHeatRow[]> {
  if (!isDbConfigured()) return [];
  const personIds = opts.personIds.filter(Boolean);
  if (personIds.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) return [];
  await ensureBowlingSchema();
  const q = sql();
  const excludeBillId = opts.excludeBillId ?? null;
  const rows = await q`
    SELECT t.e->>'heatId' AS heat_id, t.e->>'track' AS track,
           t.e->>'bmiPersonId' AS person_id, t.e->>'racer' AS racer
    FROM bowling_reservations r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.booking_metadata->'heats')='array'
           THEN r.booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)
    WHERE r.product_kind = 'race'
      AND r.status IN ('confirmed','confirm_pending')
      AND (${excludeBillId}::text IS NULL OR r.bmi_bill_id IS DISTINCT FROM ${excludeBillId})
      AND t.e->>'bmiPersonId' = ANY(${personIds})
      AND left(t.e->>'heatId', 10) = ${opts.date}
  `;
  return rows
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.heat_id === "string" && typeof r.person_id === "string")
    .map((r) => ({
      heatId: r.heat_id as string,
      track: (r.track as string | null) ?? null,
      bmiPersonId: r.person_id as string,
      racer: (r.racer as string | null) ?? null,
    }));
}

/**
 * Is this person part of an Ultimate VIP combo reservation on `date`?
 * The check-in scanner uses this to badge VIP guests. VIP = any combo leg
 * (combo_special_id set — 'race-bowl' today) whose race-leg heats include this
 * bmiPersonId on the given ET date. Same JSONB shape as
 * raceHeatsForPersonsOnDate; forward-only (heats[].bmiPersonId persisted since
 * 2026-07-02). Statuses: a combo race leg may already be 'arrived' when the
 * racer checks into their SECOND race, so exclude only dead rows.
 * Fail-open: unconfigured DB or query error returns false — a missing badge,
 * never a blocked check-in.
 */
export async function isVipComboPersonOnDate(personId: string, date: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  if (!/^\d+$/.test(personId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  try {
    await ensureBowlingSchema();
    const q = sql();
    const rows = await q`
      SELECT 1
      FROM bowling_reservations r
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(r.booking_metadata->'heats')='array'
             THEN r.booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)
      WHERE r.combo_special_id IS NOT NULL
        AND r.product_kind = 'race'
        AND r.status NOT IN ('cancelled','no_show')
        AND t.e->>'bmiPersonId' = ${personId}
        AND left(t.e->>'heatId', 10) = ${date}
      LIMIT 1
    `;
    return rows.length > 0;
  } catch (e) {
    console.warn("[bowling-db] isVipComboPersonOnDate failed:", e);
    return false;
  }
}

/** A VIP combo racer's race-leg row — enough to badge the person AND append
 *  a line to the booking memo (bmi-notes appendBookingMemoLine). */
export interface VipComboPersonLeg {
  /** BMI personId as a STRING (never Number() a BMI id). */
  bmiPersonId: string;
  /** Neon bowling_reservations.id (serial int — not a BMI id). */
  reservationId: number;
  /** RAW string bill id (17-digit — string end to end). */
  bmiBillId?: string;
  bmiReservationNumber?: string;
  centerCode: string;
  productKind: ReservationProductKind;
}

/**
 * Batched isVipComboPersonOnDate — one query for a whole roster. The check-in
 * alerts cron feeds every called racer's Pandora personId through this to pick
 * VIP-Room vs Karting-counter copy, then uses the returned race-leg identifiers
 * to log the sent SMS on the booking memo. Same JSONB shape + status filter as
 * the single-person probe; same fail-open contract (error/unconfigured DB →
 * empty map → generic copy, never a broken alert).
 */
export async function vipComboPersonLegsOnDate(
  personIds: string[],
  date: string,
): Promise<Map<string, VipComboPersonLeg>> {
  const out = new Map<string, VipComboPersonLeg>();
  if (!isDbConfigured()) return out;
  const ids = Array.from(new Set(personIds.filter((p) => /^\d+$/.test(p))));
  if (ids.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return out;
  try {
    await ensureBowlingSchema();
    const q = sql();
    const rows = await q`
      SELECT DISTINCT ON (t.e->>'bmiPersonId')
             t.e->>'bmiPersonId' AS person_id,
             r.id, r.bmi_bill_id, r.bmi_reservation_number,
             r.center_code, r.product_kind
      FROM bowling_reservations r
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(r.booking_metadata->'heats')='array'
             THEN r.booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)
      WHERE r.combo_special_id IS NOT NULL
        AND r.product_kind = 'race'
        AND r.status NOT IN ('cancelled','no_show')
        AND t.e->>'bmiPersonId' = ANY(${ids})
        AND left(t.e->>'heatId', 10) = ${date}
      ORDER BY t.e->>'bmiPersonId', r.id
    `;
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      if (typeof r.person_id !== "string") continue;
      out.set(r.person_id, {
        bmiPersonId: r.person_id,
        reservationId: Number(r.id),
        bmiBillId: (r.bmi_bill_id as string) ?? undefined,
        bmiReservationNumber: (r.bmi_reservation_number as string) ?? undefined,
        centerCode: String(r.center_code ?? ""),
        productKind: (r.product_kind as ReservationProductKind) ?? "race",
      });
    }
    return out;
  } catch (e) {
    console.warn("[bowling-db] vipComboPersonLegsOnDate failed:", e);
    return out;
  }
}

/**
 * All reservations (kbf/open/race/attraction) belonging to a VERIFIED contact,
 * for the customer account dashboard. Authorization is the contact itself — the
 * caller passes EXACTLY ONE of phone/email (the channel the customer proved via
 * OTP). We never OR the two: a single-channel session must not surface rows that
 * only match the other channel (a recycled phone an email-verified guest never
 * proved). Returns rows of EVERY status (the dashboard shows cancelled under
 * "past" with a badge); the caller splits upcoming/past on `eventAt`.
 *
 * guest_phone is stored in mixed formats, so we match on the last 10 digits on
 * BOTH sides (the br_guest_phone10 functional index covers the column side).
 * Includes lines, batch-loaded like listBowlingReservations.
 */
export async function getReservationsByContact(opts: {
  /** E.164 phone (`+1XXXXXXXXXX`). Mutually exclusive with email. */
  phone?: string;
  /** Lowercased email. Mutually exclusive with phone. */
  email?: string;
  limit?: number;
}): Promise<BowlingReservationWithLines[]> {
  if (!isDbConfigured()) return [];
  const phone10 = opts.phone ? opts.phone.replace(/\D/g, "").slice(-10) : "";
  const email = opts.email ? opts.email.trim().toLowerCase() : "";
  // Require exactly one usable channel — never run an unfiltered scan.
  if (phone10.length !== 10 && !email) return [];
  await ensureBowlingSchema();
  const q = sql();
  const limit = opts.limit ?? 200;

  // Single-channel predicate. event_at uses the SAME COALESCE expression as
  // listBowlingReservations so race/attraction rows sort by their real event
  // time, not the booking timestamp.
  const contactCond =
    phone10.length === 10
      ? q`right(regexp_replace(s.guest_phone,'\\D','','g'),10) = ${phone10}`
      : q`lower(s.guest_email) = ${email}`;

  const rows = await q`
    SELECT * FROM (
      SELECT *,
        COALESCE(
          (SELECT min(t.e->>'heatId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'heats')='array' THEN booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)),
          (SELECT min(t.e->>'slot')   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'attractions')='array' THEN booking_metadata->'attractions' ELSE '[]'::jsonb END) AS t(e)),
          to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD"T"HH24:MI:SS')
        ) AS event_at
      FROM bowling_reservations
    ) s
    WHERE ${contactCond}
    ORDER BY s.event_at DESC
    LIMIT ${limit}
  `;
  const reservations = rows.map((r) => rowToReservation(r as Record<string, unknown>));
  if (!reservations.length) return [];

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
  return reservations.map((r) => ({ ...r, lines: linesByRes.get(r.id) ?? [] }));
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
 * Flip a reserve-path anchor row confirm_pending|confirm_failed → confirmed once
 * BMI confirm + state -3 succeed. Guarded so it never overwrites a cancelled or
 * already-confirmed/arrived/completed row. Returns true if it transitioned.
 */
export async function updateBowlingReservationConfirmed(
  id: number,
  opts: { bmiReservationNumber?: string } = {},
): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    UPDATE bowling_reservations
    SET status = 'confirmed',
        bmi_reservation_number = COALESCE(${opts.bmiReservationNumber ?? null}, bmi_reservation_number)
    WHERE id = ${id} AND status IN ('confirm_pending', 'confirm_failed')
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Mark a reserve-path anchor row confirm_failed (BMI confirm failed after the
 * deposit was captured). The money stays on the gift card; the
 * race-confirm-reconcile cron retries forward. Guarded to the pending states.
 */
export async function updateBowlingReservationConfirmFailed(
  id: number,
  error: string,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET status = 'confirm_failed',
        dayof_order_error = ${error.slice(0, 500)}
    WHERE id = ${id} AND status IN ('confirm_pending', 'confirm_failed')
  `;
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

/**
 * Set check-in method on a reservation, and stamp WHEN it happened.
 *
 * `COALESCE(checked_in_at, NOW())` keeps the FIRST moment: re-running this — an admin
 * correcting the method, a retried request — must not push a guest back onto the
 * front-desk wall's "checked in" board half an hour after they actually arrived.
 * Clearing the method clears the stamp, so the two can never disagree.
 */
export async function updateBowlingCheckinMethod(
  id: number,
  method: "self" | "desk" | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET checkin_method = ${method},
        checked_in_at = CASE
          WHEN ${method}::text IS NULL THEN NULL
          ELSE COALESCE(checked_in_at, NOW())
        END
    WHERE id = ${id}
  `;
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
 * PARTIAL guest-contact edit for the admin manage-reservation view.
 *
 * Deliberately NOT updateWalkinGuestData: that helper full-overwrites
 * (an omitted field NULLs the column — correct for the QAMF webhook sync it
 * serves, wrong for a staff typo fix). Here omitted fields are untouched
 * via per-field COALESCE. Works for web AND walk-in rows.
 */
export async function updateGuestContact(
  id: number,
  opts: {
    guestName?: string;
    guestEmail?: string;
    guestPhone?: string;
  },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET guest_name  = COALESCE(${opts.guestName ?? null}, guest_name),
        guest_email = COALESCE(${opts.guestEmail ?? null}, guest_email),
        guest_phone = COALESCE(${opts.guestPhone ?? null}, guest_phone)
    WHERE id = ${id}
  `;
}

/**
 * Edit the reservation notes (admin manage-reservation view). Pass null to
 * clear. The caller re-syncs the QAMF memo (buildQamfMemo embeds notes) for
 * bowling/KBF rows so the desk sees the change in Conqueror.
 */
export async function updateBowlingReservationNotes(
  id: number,
  notes: string | null,
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET notes = ${notes}
    WHERE id = ${id}
  `;
}

/**
 * Mirror a memo we just pushed to an external system (BMI booking/memo) into
 * the reservation's own notes, so the admin Notes tab shows what the external
 * system got instead of sitting empty (owner request 2026-07-08). Matched on
 * bmi_bill_id (TEXT — 17-digit ids, never numeric). Semantics protect staff
 * edits: replace only empty/placeholder notes; skip when the memo is already
 * present (BMI's memo field is overwriting and gets rewritten with a superset
 * by the confirmation page); append otherwise.
 */
export async function mirrorMemoIntoNotesByBillId(billId: string, memo: string): Promise<void> {
  if (!isDbConfigured() || !billId || !memo.trim()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET notes = CASE
      WHEN notes IS NULL OR notes = '' OR notes LIKE 'v2 unified%' THEN ${memo}
      WHEN position(${memo} in notes) > 0 THEN notes
      WHEN position(notes in ${memo}) > 0 THEN ${memo}
      ELSE notes || E'\n' || ${memo}
    END
    WHERE bmi_bill_id = ${billId}
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
 * Race/attraction reserve-path anchors stuck at confirm_pending|confirm_failed
 * (BMI confirm never landed after the deposit was captured). Drives the
 * race-confirm-reconcile cron, which re-confirms BMI forward (the money is
 * already on the gift card). Excludes rows that exhausted the attempt budget
 * (terminal — need manual intervention).
 */
export async function getPendingBmiConfirms(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  // Age floor: reserve writes the anchor as confirm_pending BEFORE its own BMI
  // confirm, and promotes it seconds later. A cron tick landing inside that
  // window re-confirmed a bill the live reserve was confirming at that moment
  // (double payment/confirm — W57040, 2026-08-01: both sources ran the confirm
  // rail 5s apart). confirmBmiPayment is NOT idempotent, so rows only become
  // cron-eligible once they are old enough that the live reserve is certainly
  // done (route maxDuration is 60s; 3 minutes is comfortably past it).
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE product_kind IN ('race', 'attraction')
      AND status IN ('confirm_pending', 'confirm_failed')
      AND bmi_bill_id IS NOT NULL
      AND qamf_confirm_attempts < ${MAX_QAMF_CONFIRM_ATTEMPTS}
      AND inserted_at < now() - interval '3 minutes'
    ORDER BY inserted_at ASC
    LIMIT 20
  `;
  return rows.map((r) => rowToReservation(r as Record<string, unknown>));
}

/**
 * Already-`confirmed` race/attraction rows whose deposit gift card was never
 * funded after capture: the deposit payment landed and the row was promoted to
 * `confirmed`, but the gift-card create/activate step failed and
 * square_gift_card_id was never persisted. These fall in a gap between two crons
 * — getPendingBmiConfirms skips them (not pending) and race-dayof-pay skips them
 * (its candidate query needs square_gift_card_id) — so the day-of order never
 * settles and the captured deposit stays stuck on a PENDING/$0 card.
 * race-confirm-reconcile backfills the card (step-1 funding ONLY; BMI is already
 * confirmed, so it must NEVER re-confirm or downgrade the row's status). Once
 * funded, race-dayof-pay settles it normally. See the Freytag W41982 incident
 * (2026-06-27), the first such row found in production.
 */
export async function getConfirmedRowsWithUnfundedGiftCard(): Promise<BowlingReservation[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM bowling_reservations
    WHERE product_kind IN ('race', 'attraction')
      AND status = 'confirmed'
      AND square_gift_card_id IS NULL
      AND square_deposit_payment_id IS NOT NULL
      AND total_cents > 0
      AND bmi_bill_id IS NOT NULL
      AND dayof_order_sent_at IS NULL
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
  {
    squareRefundId,
    refundCents,
    cancellationOutcome,
    cancelledBy,
  }: {
    squareRefundId?: string;
    refundCents: number;
    /** Omitted by legacy callers — column stays NULL for them. */
    cancellationOutcome?: "refund" | "store_credit" | "none";
    cancelledBy?: "customer" | "admin";
  },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET
      status               = 'cancelled',
      cancelled_at         = NOW(),
      square_refund_id     = ${squareRefundId ?? null},
      refund_cents         = ${refundCents},
      cancellation_outcome = COALESCE(${cancellationOutcome ?? null}, cancellation_outcome),
      cancelled_by         = COALESCE(${cancelledBy ?? null}, cancelled_by)
    WHERE id = ${id}
  `;
}

/**
 * Persist the store-credit gift card BEFORE delivery is attempted (and before
 * the cascade continues past the mint) so the GAN is recoverable from the
 * portal even if activation verification, teardown, or email/SMS fail.
 * Called with state 'issuing' right after the card object exists, then
 * 'issued' once the ACTIVATE is verified.
 */
export async function updateStoreCreditIssued(
  id: number,
  sc: { giftCardId: string; gan: string; cents: number; state: "issuing" | "issued" },
): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET
      store_credit_gift_card_id  = ${sc.giftCardId},
      store_credit_gift_card_gan = ${sc.gan},
      store_credit_cents         = ${sc.cents},
      store_credit_state         = ${sc.state}
    WHERE id = ${id}
  `;
}

/** Stamp the time the cancellation email/SMS went out (per anchor row). */
export async function markCancelNotified(id: number): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureBowlingSchema();
  const q = sql();
  await q`
    UPDATE bowling_reservations SET cancel_notified_at = NOW() WHERE id = ${id}
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
    SELECT deposit_cents, notes, short_code, center_code
    FROM bowling_reservations WHERE id = ${reservationId}
  `;
  if (!resRows.length) return "";
  const res = resRows[0] as {
    deposit_cents: number;
    notes: string | null;
    short_code: string | null;
    center_code: string | null;
  };
  const isFastTrax = res.center_code === FASTTRAX_CENTER_CODE;

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

  // Shoe status + short URL. FastTrax duckpin has no shoes — omit the shoe
  // status entirely (a "SHOES NOT INCLUDED" note would confuse duckpin staff)
  // and brand the short link to fasttraxent.com.
  if (isFastTrax) {
    if (res.short_code) parts.push(`fasttraxent.com/s/${res.short_code}`);
  } else {
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
  }

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

  // FastTrax duckpin has no shoes — force allowance 0 so every shoe UI/roster
  // path stays dark, independent of catalog/label heuristics. (Defensive: the
  // FastTrax catalog also seeds no addon_shoe and a non-matching slug.)
  const ftRows = await q`
    SELECT center_code FROM bowling_reservations WHERE id = ${reservationId}
  `;
  if ((ftRows[0] as Record<string, unknown>)?.center_code === FASTTRAX_CENTER_CODE) {
    return {
      players: playerRows.map((r) => rowToPlayer(r as Record<string, unknown>)),
      shoePairsAllowed: 0,
    };
  }

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

/**
 * Commit a reservation edit to Neon in one call: replace the priced lines,
 * update player_count / total_cents / deposit_cents, refresh the pricing
 * stamp, and true-up the player slot rows (extra slots beyond the new count
 * are deleted; missing slots are inserted). Called by the reservation-edit
 * cascade AFTER the Square money steps succeed — Neon mirrors what Square
 * now holds.
 */
export async function updateReservationAfterEdit(
  reservationId: number,
  update: {
    lines: ReservationLine[];
    playerCount?: number;
    totalCents: number;
    depositCents?: number;
    /** Refreshed booking_metadata.bowling stamp (laneCount changes). */
    bowlingStamp?: Record<string, unknown>;
    players?: Array<{
      slot: number;
      name?: string | null;
      shoeSize?: string | null;
      bumpers?: boolean | null;
    }>;
    qamfReservationId?: string;
    appendNote?: string;
  },
): Promise<void> {
  if (!isDbConfigured()) throw new Error("bowling-db: DATABASE_URL not configured");
  await ensureBowlingSchema();
  const q = sql();

  await q`
    UPDATE bowling_reservations SET
      total_cents   = ${update.totalCents},
      deposit_cents = COALESCE(${update.depositCents ?? null}, deposit_cents),
      player_count  = COALESCE(${update.playerCount ?? null}, player_count),
      qamf_reservation_id = COALESCE(${update.qamfReservationId ?? null}, qamf_reservation_id),
      booking_metadata = CASE
        WHEN ${update.bowlingStamp ? JSON.stringify(update.bowlingStamp) : null}::jsonb IS NULL
          THEN booking_metadata
        ELSE COALESCE(booking_metadata, '{}'::jsonb)
             || jsonb_build_object('bowling', ${update.bowlingStamp ? JSON.stringify(update.bowlingStamp) : null}::jsonb)
      END,
      notes = CASE
        WHEN ${update.appendNote ?? null}::text IS NULL THEN notes
        ELSE CONCAT_WS(E'\n', NULLIF(notes, ''), ${update.appendNote ?? null}::text)
      END
    WHERE id = ${reservationId}
  `;

  await q`DELETE FROM bowling_reservation_lines WHERE reservation_id = ${reservationId}`;
  for (const line of update.lines) {
    await q`
      INSERT INTO bowling_reservation_lines
        (reservation_id, square_product_id, label, quantity, unit_price_cents)
      VALUES
        (${reservationId}, ${line.squareProductId ?? null}, ${line.label},
         ${line.quantity}, ${line.unitPriceCents})
    `;
  }

  if (update.players) {
    for (const p of update.players) {
      await q`
        INSERT INTO bowling_reservation_players (reservation_id, slot, name, shoe_size, bumpers)
        VALUES (${reservationId}, ${p.slot}, ${p.name ?? null}, ${p.shoeSize ?? null}, ${p.bumpers ?? null})
        ON CONFLICT (reservation_id, slot) DO UPDATE SET
          name = EXCLUDED.name,
          shoe_size = EXCLUDED.shoe_size,
          bumpers = EXCLUDED.bumpers,
          updated_at = NOW()
      `;
    }
    const keepSlots = update.players.map((p) => p.slot);
    if (update.playerCount != null) {
      await q`
        DELETE FROM bowling_reservation_players
        WHERE reservation_id = ${reservationId}
          AND slot > ${update.playerCount}
          AND NOT (slot = ANY(${keepSlots}))
      `;
    }
  } else if (update.playerCount != null) {
    await q`
      DELETE FROM bowling_reservation_players
      WHERE reservation_id = ${reservationId} AND slot > ${update.playerCount}
    `;
  }
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
    qamfOfferDurationMinutes:
      row.duration_minutes != null ? (row.duration_minutes as number) : null,
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
          bei.quantity, bei.sort_order,
          bei.included_modifier_count, bei.extra_modifier_cents
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
          bei.quantity, bei.sort_order,
          bei.included_modifier_count, bei.extra_modifier_cents
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
      includedModifierCount: (r.included_modifier_count as number) ?? 1,
      extraModifierCents: (r.extra_modifier_cents as number) ?? 0,
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
 *
 * `includePreviewPinboyz` (pinboyz seam): additionally returns the
 * INACTIVE `pinboyz-*` experiences. The PinBoyz rows are seeded with
 * is_active = FALSE so the live site never lists them; the tier-switcher
 * v3 surfaces opt in explicitly. Remove this seam when the lane-type enum
 * migration lands and the rows go active for real.
 */
export async function getBowlingExperiences(
  centerCode: string,
  kind?: BowlingExperienceKind,
  includePreviewPinboyz = false,
): Promise<BowlingExperienceWithDetails[]> {
  if (!isDbConfigured()) return [];
  await ensureBowlingSchema();
  const q = sql();

  // 1. Fetch experience rows joined to the center's offer. The active filter
  //    widens to inactive pinboyz-* rows only when the preview opts in.
  const offerRows = kind
    ? await q`
        SELECT e.*, eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id, eo.duration_minutes
        FROM bowling_experiences e
        JOIN bowling_experience_offers eo
          ON eo.experience_id = e.id
         AND eo.center_code   = ${centerCode}
         AND eo.is_active      = TRUE
        WHERE (e.is_active = TRUE
               OR (${includePreviewPinboyz} AND e.slug LIKE 'pinboyz-%'))
          AND e.kind = ${kind}
        ORDER BY e.sort_order, e.id
      `
    : await q`
        SELECT e.*, eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id, eo.duration_minutes
        FROM bowling_experiences e
        JOIN bowling_experience_offers eo
          ON eo.experience_id = e.id
         AND eo.center_code   = ${centerCode}
         AND eo.is_active      = TRUE
        WHERE (e.is_active = TRUE
               OR (${includePreviewPinboyz} AND e.slug LIKE 'pinboyz-%'))
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
      qamfOfferDurationMinutes:
        row.duration_minutes != null ? (row.duration_minutes as number) : null,
      items: itemMap.get(eid) ?? [],
      durationOptions: durationMap.get(eid) ?? [],
    };
  });
}

/**
 * Look up the experience for a specific QAMF web offer ID at a center.
 * When multiple experiences share a web offer (e.g. Fun 4 All + hourly),
 * pass `kind` to disambiguate. Without `kind`, returns the first match.
 */
export async function getBowlingExperienceByOffer(
  centerCode: string,
  qamfWebOfferId: number,
  kind?: BowlingExperienceKind,
): Promise<BowlingExperienceWithDetails | null> {
  if (!isDbConfigured()) return null;
  await ensureBowlingSchema();
  const q = sql();

  const offerRows = kind
    ? await q`
        SELECT e.*, eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id, eo.duration_minutes
        FROM bowling_experiences e
        JOIN bowling_experience_offers eo
          ON eo.experience_id    = e.id
         AND eo.center_code       = ${centerCode}
         AND eo.qamf_web_offer_id = ${qamfWebOfferId}
         AND eo.is_active          = TRUE
        WHERE e.is_active = TRUE AND e.kind = ${kind}
        LIMIT 1
      `
    : await q`
        SELECT e.*, eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id, eo.duration_minutes
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
    qamfOfferDurationMinutes:
      row.duration_minutes != null ? (row.duration_minutes as number) : null,
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
 * Matches on (experience_id, center_code) — one offer row per experience per center.
 * Multiple experiences CAN share the same qamf_web_offer_id.
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
    ON CONFLICT (experience_id, center_code) DO UPDATE SET
      qamf_web_offer_id = EXCLUDED.qamf_web_offer_id,
      qamf_option_type  = EXCLUDED.qamf_option_type,
      qamf_option_id    = EXCLUDED.qamf_option_id,
      is_active         = EXCLUDED.is_active
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
 * When `opts.retryable` is true, this records the error and lane/source
 * metadata but leaves `dayof_order_sent_at` NULL, so the lane-poll cron
 * (and subsequent webhooks) can retry. Square calls inside processLaneOpen
 * all use stable idempotency keys so retries are safe.
 *
 * Called by both the bowling-events-consumer (webhook path) and the
 * bowling-lane-poll cron (polling fallback). Both use the same
 * idempotency keys so concurrent triggers are safe.
 */
export async function updateBowlingReservationLaneOpen(
  id: number,
  opts: {
    laneNumbers: number[];
    paymentId?: string;
    error?: string;
    source?: string;
    retryable?: boolean;
  },
): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureBowlingSchema();
  const q = sql();
  const laneLabel = opts.laneNumbers.join(",");

  if (opts.retryable) {
    // Transient failure (429/5xx/network). Record the error so admins see
    // something went wrong, but do NOT set dayof_order_sent_at — that
    // would burn the idempotency guard and prevent the lane-poll cron
    // from retrying. Also don't advance status; let the QAMF status
    // events drive that as usual.
    const rows = await q`
      UPDATE bowling_reservations SET
        dayof_order_lane   = ${laneLabel || null},
        dayof_order_error  = ${opts.error ?? null},
        dayof_order_source = ${opts.source ?? null}
      WHERE id = ${id}
        AND dayof_order_sent_at IS NULL
        AND status != 'cancelled'
      RETURNING id
    `;
    return rows.length > 0;
  }

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
