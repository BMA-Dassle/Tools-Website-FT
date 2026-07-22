/**
 * Seed FastTrax DUCKPIN catalog on QAMF (center 11542).
 *
 * Creates the Neon rows the booking + kiosk flows need for FastTrax duckpin:
 *   - bowling_square_products   : the 3 price points (30/60/90), product_kind 'open',
 *                                 NO 'addon_shoe' (that is how shoes stay absent).
 *   - bowling_experiences       : one 'duckpin' experience, kind 'hourly' (per-lane),
 *                                 non-VIP, slug 'duckpin' (must NOT match pizza-bowl/
 *                                 fun-4-all/world-cup or the shoe-included path fires).
 *   - bowling_experience_offers : QAMF web offer 5, option_type 'Time'.
 *   - bowling_experience_items  : the base priced product.
 *   - bowling_experience_duration_options : 30/60/90 → QAMF Time option ids 33/34/35,
 *                                 each overriding to its own price product.
 *
 * Usage:  npx tsx scripts/seed-fasttrax-duckpin.ts
 * Requires DATABASE_URL in .env.local.
 *
 * ⚠️ BLOCKED ON OWNER INPUT — do NOT run until the TODOs below are filled:
 *   1. The three prices (30/60/90 min) in cents.
 *   2. Three distinct Square catalog VARIATION ids (one per duration) so each
 *      duration can price off its own product row. If only one duckpin Square
 *      item exists ("EXW7E74IRPYJAQFA4YIIEW3G", currently $0-default), create
 *      three variations in Square first — a single shared variation id cannot
 *      back three product rows (unique index on center_code+kind+catalog_id).
 * Everything is seeded is_active = FALSE; flip active after prices are confirmed
 * (mirrors seed-bowling-products.ts). Per-lane pricing (kind 'hourly'); deposit 100%.
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
    if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim();
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

// ── FastTrax center_code = its Square location id (Lee County). ────────────────
const FT = "LAB52GY480CJF";

// ── QAMF web offer 5, Time option ids (confirmed live via the center-live probe).
const WEB_OFFER_ID = 5;
const OPT_30 = 33;
const OPT_60 = 34;
const OPT_90 = 35;

// ── TODO(owner): fill real prices + distinct Square variation ids. ─────────────
// Prices in cents. Per-lane, deposit 100%. Placeholders below are OBVIOUSLY wrong
// so a stray run can't ring up a real (incorrect) charge — the products stay
// is_active=false regardless until these are confirmed.
const DURATIONS = [
  {
    minutes: 30,
    optId: OPT_30,
    label: "30 Minutes",
    priceCents: 0,
    varId: "TODO_DUCKPIN_30_VARIATION",
  },
  {
    minutes: 60,
    optId: OPT_60,
    label: "1 Hour",
    priceCents: 0,
    varId: "TODO_DUCKPIN_60_VARIATION",
  },
  {
    minutes: 90,
    optId: OPT_90,
    label: "90 Minutes",
    priceCents: 0,
    varId: "TODO_DUCKPIN_90_VARIATION",
  },
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

async function upsertProduct(d: (typeof DURATIONS)[number]): Promise<number> {
  const rows = await sql`
    INSERT INTO bowling_square_products
      (center_code, product_kind, label, square_catalog_object_id, price_cents, deposit_pct, sort_order, is_active)
    VALUES
      (${FT}, 'open', ${`Duckpin ${d.label}`}, ${d.varId}, ${d.priceCents}, 100, ${d.minutes}, FALSE)
    ON CONFLICT (center_code, product_kind, square_catalog_object_id)
    DO UPDATE SET label = EXCLUDED.label, price_cents = EXCLUDED.price_cents,
      deposit_pct = EXCLUDED.deposit_pct, sort_order = EXCLUDED.sort_order
    RETURNING id`;
  return (rows[0] as { id: number }).id;
}

async function main() {
  if (DURATIONS.some((d) => d.priceCents <= 0 || d.varId.startsWith("TODO"))) {
    console.error(
      "\n⛔ Refusing to seed: fill the TODO prices + Square variation ids first (see file header).\n" +
        "   Products would be created is_active=FALSE, but seeding placeholder catalog ids is still unsafe.\n",
    );
    process.exit(1);
  }

  console.log("Ensuring schema…");
  await ensureSchema();

  console.log("Seeding duckpin price products…");
  const productIdByOpt = new Map<number, number>();
  for (const d of DURATIONS) {
    const id = await upsertProduct(d);
    productIdByOpt.set(d.optId, id);
    console.log(
      `  product "${`Duckpin ${d.label}`}" → id=${id}  $${(d.priceCents / 100).toFixed(2)}`,
    );
  }

  console.log("Seeding duckpin experience…");
  const expRows = await sql`
    INSERT INTO bowling_experiences (slug, label, kind, is_vip, description, sort_order, is_active, days_of_week)
    VALUES ('duckpin', 'Duckpin Bowling', 'hourly', FALSE, 'FastTrax duckpin — 30/60/90 minutes', 10, FALSE, '{0,1,2,3,4,5,6}')
    ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind,
      is_vip = EXCLUDED.is_vip, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order,
      days_of_week = EXCLUDED.days_of_week
    RETURNING id`;
  const experienceId = (expRows[0] as { id: number }).id;
  console.log(`  experience "duckpin" → id=${experienceId}`);

  // Offer: web offer 5, Time. Delete-then-insert to avoid the stale
  // ON CONFLICT (center_code, qamf_web_offer_id) vs UNIQUE(experience_id, center_code) mismatch.
  await sql`DELETE FROM bowling_experience_offers WHERE experience_id = ${experienceId} AND center_code = ${FT}`;
  await sql`
    INSERT INTO bowling_experience_offers
      (experience_id, center_code, qamf_web_offer_id, qamf_option_type, qamf_option_id, duration_minutes, is_active)
    VALUES (${experienceId}, ${FT}, ${WEB_OFFER_ID}, 'Time', NULL, NULL, TRUE)`;
  console.log(`  offer  FastTrax  webOfferId=${WEB_OFFER_ID}  Time`);

  // Base item = the 60-min product (representative for the FK).
  const baseProductVar = DURATIONS.find((d) => d.minutes === 60)!.varId;
  await sql`DELETE FROM bowling_experience_items WHERE experience_id = ${experienceId}`;
  await sql`
    INSERT INTO bowling_experience_items
      (experience_id, square_product_id, square_catalog_object_id, quantity, label_override, sort_order, center_code)
    VALUES (${experienceId}, ${productIdByOpt.get(OPT_60)}, ${baseProductVar}, 1, NULL, 0, ${FT})`;

  // Duration options 30/60/90 → Time option ids 33/34/35; each prices off its own product.
  await sql`DELETE FROM bowling_experience_duration_options WHERE experience_id = ${experienceId} AND center_code = ${FT}`;
  for (const [i, d] of DURATIONS.entries()) {
    await sql`
      INSERT INTO bowling_experience_duration_options
        (experience_id, center_code, qamf_option_id, duration_minutes, label, square_multiplier, sort_order, override_square_product_id)
      VALUES (${experienceId}, ${FT}, ${d.optId}, ${d.minutes}, ${d.label}, 1, ${i}, ${productIdByOpt.get(d.optId)})`;
    console.log(`  duration  optId=${d.optId}  ${d.label}`);
  }

  console.log("\nDone (is_active=FALSE). Activate after final price review:");
  console.log("  UPDATE bowling_experiences SET is_active=TRUE WHERE slug='duckpin';");
  console.log(
    "  UPDATE bowling_square_products SET is_active=TRUE WHERE center_code='LAB52GY480CJF' AND product_kind='open';",
  );
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
