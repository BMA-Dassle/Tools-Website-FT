/**
 * Seed FastTrax DUCKPIN catalog on QAMF (center 11542).
 *
 * Creates the Neon rows the booking + kiosk flows need for FastTrax duckpin:
 *   - bowling_square_products   : ONE base price product ($17.50 / 30-min unit),
 *                                 product_kind 'open', NO 'addon_shoe' (that is
 *                                 how shoes stay absent). QAMF web offer 5.
 *   - bowling_experiences       : one 'duckpin' experience, non-VIP, slug 'duckpin'
 *                                 (must NOT match pizza-bowl/fun-4-all or the
 *                                 shoe-included path fires).
 *   - bowling_experience_offers : QAMF web offer 5, option_type 'Time'.
 *   - bowling_experience_items  : the base priced product.
 *   - bowling_experience_duration_options : 30/60/90 → QAMF Time option ids
 *                                 33/34/35, square_multiplier 1/2/3.
 *
 * PRICING MODEL — the Square variation EXW7E74IRPYJAQFA4YIIEW3G ("Regular" under
 * "Intercard - Duckpin") is VARIABLE_PRICING: Square stores no price; ours does.
 * Legacy BMI duckpin was 30-min $17.50 and 1-hr $35.00 (exactly 2×), so the price
 * is linear and modeled as a $17.50 base unit whose QUANTITY scales by the
 * duration multiplier (30→×1, 60→×2, 90→×3) — the same mechanism HeadPinz uses
 * for 2hr = 1hr×2. No per-duration override product and no extra Square
 * variations are needed. 90 min = $52.50 (×3) by linear extension.
 *
 * ⚠️ TWO OWNER CONFIRMATIONS (seeded is_active=FALSE until confirmed):
 *   1. PER_PERSON vs PER_LANE. Default PER_PERSON (kind 'open') — matches the BMI
 *      attraction, which sold per unit up to 6. If duckpin is a flat LANE rate,
 *      set PER_LANE=true (kind 'hourly') and re-run.
 *   2. 90-min price = $52.50 (linear ×3). Change BASE_PRICE_CENTS math if not.
 *
 * Usage:  npx tsx scripts/seed-fasttrax-duckpin.ts
 * Requires DATABASE_URL in .env.local.
 */

import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { resolve } from "path";

try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!(k in process.env) || !process.env[k]) process.env[k] = v;
  }
} catch {
  /* rely on env */
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = neon(DATABASE_URL);

// FastTrax center_code = its Square location id (Lee County).
const FT = "LAB52GY480CJF";
// The single VARIABLE_PRICING duckpin variation ("Intercard - Duckpin / Regular").
const DUCKPIN_VARIATION = "EXW7E74IRPYJAQFA4YIIEW3G";

// QAMF web offer 5, Time option ids (confirmed live via the center-live probe).
const WEB_OFFER_ID = 5;

// Base unit = 30 min. Legacy BMI: 30-min $17.50, 60-min $35.00 (linear).
const BASE_PRICE_CENTS = 1750;

// PER_PERSON (kind 'open') vs PER_LANE (kind 'hourly'). See header ⚠ #1.
const PER_LANE = false;
const EXPERIENCE_KIND = PER_LANE ? "hourly" : "open";

// 30/60/90 → QAMF Time option ids; multiplier scales the base unit's quantity.
const DURATIONS = [
  { minutes: 30, optId: 33, label: "30 Minutes", multiplier: 1 },
  { minutes: 60, optId: 34, label: "1 Hour", multiplier: 2 },
  { minutes: 90, optId: 35, label: "90 Minutes", multiplier: 3 },
] as const;

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS bowling_experience_duration_options (
      id                SERIAL  PRIMARY KEY,
      experience_id     INTEGER NOT NULL REFERENCES bowling_experiences(id),
      center_code       TEXT    NOT NULL,
      qamf_option_id    INTEGER NOT NULL,
      duration_minutes  INTEGER NOT NULL,
      label             TEXT    NOT NULL,
      square_multiplier INTEGER NOT NULL DEFAULT 1,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      UNIQUE (experience_id, center_code, qamf_option_id)
    )`;
  await sql`ALTER TABLE bowling_experience_duration_options ADD COLUMN IF NOT EXISTS override_square_product_id INTEGER REFERENCES bowling_square_products(id)`;
  await sql`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS square_catalog_object_id TEXT`;
  await sql`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS center_code TEXT`;
  await sql`ALTER TABLE bowling_experiences ADD COLUMN IF NOT EXISTS days_of_week INTEGER[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}'`;
}

async function main() {
  console.log(
    `Seeding FastTrax duckpin (${PER_LANE ? "per-lane" : "per-person"}, base $${(BASE_PRICE_CENTS / 100).toFixed(2)})…`,
  );
  await ensureSchema();

  // ── Base price product (single row; durations scale via multiplier) ──────────
  const prodRows = await sql`
    INSERT INTO bowling_square_products
      (center_code, product_kind, label, square_catalog_object_id, price_cents, deposit_pct, sort_order, is_active)
    VALUES
      (${FT}, 'open', 'Duckpin (30 min unit)', ${DUCKPIN_VARIATION}, ${BASE_PRICE_CENTS}, 100, 30, FALSE)
    ON CONFLICT (center_code, product_kind, square_catalog_object_id)
    DO UPDATE SET label = EXCLUDED.label, price_cents = EXCLUDED.price_cents,
      deposit_pct = EXCLUDED.deposit_pct, sort_order = EXCLUDED.sort_order
    RETURNING id`;
  const productId = (prodRows[0] as { id: number }).id;
  console.log(`  product → id=${productId}`);

  // ── Experience ───────────────────────────────────────────────────────────────
  const expRows = await sql`
    INSERT INTO bowling_experiences (slug, label, kind, is_vip, description, sort_order, is_active, days_of_week)
    VALUES ('duckpin', 'Duckpin Bowling', ${EXPERIENCE_KIND}, FALSE, 'FastTrax duckpin — 30/60/90 minutes', 10, FALSE, '{0,1,2,3,4,5,6}')
    ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind,
      is_vip = EXCLUDED.is_vip, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order,
      days_of_week = EXCLUDED.days_of_week
    RETURNING id`;
  const experienceId = (expRows[0] as { id: number }).id;
  console.log(`  experience "duckpin" (${EXPERIENCE_KIND}) → id=${experienceId}`);

  // ── Offer (web offer 5, Time). Delete-then-insert avoids the stale ON CONFLICT.
  await sql`DELETE FROM bowling_experience_offers WHERE experience_id = ${experienceId} AND center_code = ${FT}`;
  await sql`
    INSERT INTO bowling_experience_offers
      (experience_id, center_code, qamf_web_offer_id, qamf_option_type, qamf_option_id, duration_minutes, is_active)
    VALUES (${experienceId}, ${FT}, ${WEB_OFFER_ID}, 'Time', NULL, NULL, TRUE)`;
  console.log(`  offer  webOfferId=${WEB_OFFER_ID}  Time`);

  // ── Base item ────────────────────────────────────────────────────────────────
  await sql`DELETE FROM bowling_experience_items WHERE experience_id = ${experienceId}`;
  await sql`
    INSERT INTO bowling_experience_items
      (experience_id, square_product_id, square_catalog_object_id, quantity, label_override, sort_order, center_code)
    VALUES (${experienceId}, ${productId}, ${DUCKPIN_VARIATION}, 1, NULL, 0, ${FT})`;

  // ── Duration options 30/60/90 → Time option ids 33/34/35, multiplier 1/2/3 ────
  await sql`DELETE FROM bowling_experience_duration_options WHERE experience_id = ${experienceId} AND center_code = ${FT}`;
  for (const [i, d] of DURATIONS.entries()) {
    await sql`
      INSERT INTO bowling_experience_duration_options
        (experience_id, center_code, qamf_option_id, duration_minutes, label, square_multiplier, sort_order, override_square_product_id)
      VALUES (${experienceId}, ${FT}, ${d.optId}, ${d.minutes}, ${d.label}, ${d.multiplier}, ${i}, NULL)`;
    const price = (BASE_PRICE_CENTS * d.multiplier) / 100;
    console.log(
      `  duration  optId=${d.optId}  ${d.label}  ×${d.multiplier}  $${price.toFixed(2)} ${PER_LANE ? "/lane" : "/person"}`,
    );
  }

  console.log(
    "\nDone (is_active=FALSE). After confirming per-person vs per-lane + the 90-min price:",
  );
  console.log("  UPDATE bowling_experiences SET is_active=TRUE WHERE slug='duckpin';");
  console.log(
    "  UPDATE bowling_square_products SET is_active=TRUE WHERE center_code='LAB52GY480CJF' AND product_kind='open';",
  );
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
