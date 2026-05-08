/**
 * Seed bowling_square_products table with initial product catalog.
 *
 * Usage:
 *   npx tsx scripts/seed-bowling-products.ts
 *
 * Requires DATABASE_URL in env (reads from .env.local).
 *
 * All open bowling products are seeded with is_active = FALSE so they don't
 * appear in the wizard until ops confirms QAMF web offer IDs and activates
 * them via:
 *   POST /api/admin/bowling/v2/square-products
 *     { ...fields, isActive: true, qamfWebOfferId: <id> }
 *
 * Shoe rental:
 *   Square catalog variation: "Shoe Rental / Regular"
 *   Variation ID: BVJ2ZSW6N4FPSPSPSB4IN7LA   (present_at_all_locations: true)
 *   Price: $5.00 (500 cents)
 *   Deposit: 100% (charged in full at booking)
 *
 * Open bowling products (from Square catalog, 2026-05-08):
 *   All seeded with depositPct = 100 (full deposit charged at booking).
 *   qamf_web_offer_id = NULL until ops links each product to a QAMF offer via
 *   GET /api/bowling/v2/offers?centerId=<id>, then updates via admin endpoint.
 */

import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { resolve } from "path";

// Manual .env.local loader (no dotenv dep needed)
try {
  const envPath = resolve(process.cwd(), ".env.local");
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env.local not present — rely on already-set env vars
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// ── Shoe rental ───────────────────────────────────────────────────────────────
//   Square catalog variation "Shoe Rental / Regular"
//   present_at_all_locations: true → same variation ID for FM + Naples
const SHOE_VAR_ID = "BVJ2ZSW6N4FPSPSPSB4IN7LA";

// ── Open bowling Square catalog variation IDs ─────────────────────────────────
//   These are Square item variation IDs from the HeadPinz catalog.
//   Same variations used at both locations (present_at_all_locations: true).
//   qamfWebOfferId must be set per-product after ops consults:
//     GET /api/bowling/v2/offers?centerId=9172  (FM)
//     GET /api/bowling/v2/offers?centerId=3148  (Naples)
const OPEN_PRODUCTS: Array<{
  label: string;
  squareCatalogObjectId: string;
  priceCents: number;
  sortOrder: number;
}> = [
  // ── Per-hour time bowling ──────────────────────────────────────────
  { label: "1 Hr Mon-Thur",         squareCatalogObjectId: "C2I2FUTKZODAXBL4N7NB4OZG", priceCents:  3000, sortOrder: 10 },
  { label: "1 Hr Mon-Thur VIP",     squareCatalogObjectId: "PI67DZQJVGR5EIXEWLB2ELOJ", priceCents:  4500, sortOrder: 11 },
  { label: "1 Hr Fri-Sun",          squareCatalogObjectId: "QA2R6YZ3D64X63NGQ46LYZRV", priceCents:  4000, sortOrder: 12 },
  { label: "1 Hr Fri-Sun VIP",      squareCatalogObjectId: "OSOZ7RJ6WW7G4CEFL55U7LXF", priceCents:  5500, sortOrder: 13 },
  { label: "1.5 Hr Mon-Thur",       squareCatalogObjectId: "43HJHFSYZNB42NWB2CM7UKOV", priceCents:  4500, sortOrder: 20 },
  { label: "1.5 Hr Mon-Thur VIP",   squareCatalogObjectId: "BESYYLCKLOVD7YE4GYJU24HR", priceCents:  6750, sortOrder: 21 },
  { label: "1.5 Hr Fri-Sun",        squareCatalogObjectId: "BA7XH63Z3KZOYEU5GGTEPASR", priceCents:  6000, sortOrder: 22 },
  { label: "1.5 Hr Fri-Sun VIP",    squareCatalogObjectId: "UFD6XVXU6GKCIRCLRUFLSKMJ", priceCents:  8250, sortOrder: 23 },
  // ── Unlimited / specialty deals ────────────────────────────────────
  { label: "Deals After Dark Unlimited VIP", squareCatalogObjectId: "YSA5ATSXBCQWXGG5VP3YFYMX", priceCents:  1399, sortOrder: 30 },
  { label: "Fun 4 All",             squareCatalogObjectId: "TOKSMRAUZSSCXSTJHSZ22TTU", priceCents:  1599, sortOrder: 40 },
  { label: "Fun 4 All - VIP",       squareCatalogObjectId: "RA3DBEYZVIEKIHON7KVMNRMQ", priceCents:  1799, sortOrder: 41 },
  { label: "Lunch & Bowl",          squareCatalogObjectId: "ELVHSZIYEOEOTFQDAS6FYDIS", priceCents:  1499, sortOrder: 50 },
  { label: "Lunch & Bowl VIP",      squareCatalogObjectId: "TH2WRVV2M4UVROYKIPPCIBM2", priceCents:  1699, sortOrder: 51 },
  { label: "Midnight Madness",      squareCatalogObjectId: "ND5N3PMV4AZ5I47U3BJZMLKW", priceCents:  1199, sortOrder: 60 },
  { label: "Midnight Madness VIP",  squareCatalogObjectId: "G6G2AZV3HHKAWLIZUJVVMOVD", priceCents:  1399, sortOrder: 61 },
  // ── NYE events ─────────────────────────────────────────────────────
  { label: "NYE Adult Party - Regular",  squareCatalogObjectId: "AR3NFJIM5V37RWKOBMVQMCH5", priceCents: 11900, sortOrder: 70 },
  { label: "NYE Adult Party - VIP",      squareCatalogObjectId: "YK2QS7F4UECPCHS37PELUDBQ", priceCents: 14400, sortOrder: 71 },
  { label: "NYE Family Party - Regular", squareCatalogObjectId: "IOTVXOB3W2OCAE2PWR7673VO", priceCents:  9900, sortOrder: 72 },
  { label: "NYE Family Party - VIP",     squareCatalogObjectId: "WOUN6QDIFAOM3M3UB3Q4S73H", priceCents: 12400, sortOrder: 73 },
  // ── Pizza deals ────────────────────────────────────────────────────
  { label: "Pizza Bowl - Regular",  squareCatalogObjectId: "GWQQDLD5J3XAZAOU5STJL3VF", priceCents:  6495, sortOrder: 80 },
  { label: "Pizza Bowl - VIP",      squareCatalogObjectId: "3BET7DOSFNF64GNPMOZTI5SJ", priceCents:  7995, sortOrder: 81 },
];

const CENTERS = ["TXBSQN0FEKQ11", "PPTR5G2N0QXF7"] as const;

interface ProductSeed {
  centerCode: string;
  productKind: string;
  label: string;
  squareCatalogObjectId: string;
  priceCents: number;
  depositPct: number;
  sortOrder: number;
  isActive: boolean;
  qamfWebOfferId?: number;
}

function buildProducts(): ProductSeed[] {
  const products: ProductSeed[] = [];

  for (const centerCode of CENTERS) {
    // ── Shoe rental ──────────────────────────────────────────────────
    products.push({
      centerCode,
      productKind: "addon_shoe",
      label: "Shoe Rental",
      squareCatalogObjectId: SHOE_VAR_ID,
      priceCents: 500,        // $5.00
      depositPct: 100,        // charged in full at booking
      sortOrder: 0,
      isActive: false,        // activate when ops confirms
    });

    // ── Open bowling products ────────────────────────────────────────
    //   qamfWebOfferId is NULL until ops links each product to a QAMF offer.
    for (const op of OPEN_PRODUCTS) {
      products.push({
        centerCode,
        productKind: "open",
        label: op.label,
        squareCatalogObjectId: op.squareCatalogObjectId,
        priceCents: op.priceCents,
        depositPct: 100,      // full deposit at booking
        sortOrder: op.sortOrder,
        isActive: false,      // activate after setting qamfWebOfferId
      });
    }

    // ── Attraction stubs (activate when Square items are created) ────
    products.push({
      centerCode,
      productKind: "addon_attraction",
      label: "Laser Tag Add-On",
      squareCatalogObjectId: `TBD_LASER_TAG_${centerCode.slice(0, 3)}`,
      priceCents: 1000,
      depositPct: 100,
      sortOrder: 0,
      isActive: false,
    });
    products.push({
      centerCode,
      productKind: "addon_attraction",
      label: "Gel Blaster Add-On",
      squareCatalogObjectId: `TBD_GEL_BLASTER_${centerCode.slice(0, 3)}`,
      priceCents: 1200,
      depositPct: 100,
      sortOrder: 1,
      isActive: false,
    });

    // ── Food stubs ───────────────────────────────────────────────────
    products.push({
      centerCode,
      productKind: "addon_food",
      label: "Food & Beverage Package",
      squareCatalogObjectId: `TBD_FOOD_PKG_${centerCode.slice(0, 3)}`,
      priceCents: 0,
      depositPct: 100,
      sortOrder: 0,
      isActive: false,
    });
  }

  return products;
}

async function main() {
  console.log("Bootstrapping bowling schema...");

  await sql`
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
  await sql`ALTER TABLE bowling_square_products ADD COLUMN IF NOT EXISTS qamf_web_offer_id INTEGER`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS bsp_upsert_key ON bowling_square_products(center_code, product_kind, square_catalog_object_id)`;
  await sql`CREATE INDEX IF NOT EXISTS bsp_center_kind ON bowling_square_products(center_code, product_kind)`;
  await sql`CREATE INDEX IF NOT EXISTS bsp_qamf_offer ON bowling_square_products(qamf_web_offer_id) WHERE qamf_web_offer_id IS NOT NULL`;

  console.log("Schema ready.");

  const products = buildProducts();
  console.log(`\nUpserting ${products.length} products (${CENTERS.length} centers × items)...\n`);

  for (const p of products) {
    // qamf_web_offer_id is only set by ops after confirming offer IDs —
    // omit from upsert so existing values aren't overwritten on re-seed.
    const result = await sql`
      INSERT INTO bowling_square_products
        (center_code, product_kind, label, square_catalog_object_id,
         price_cents, deposit_pct, sort_order, is_active)
      VALUES
        (${p.centerCode}, ${p.productKind}, ${p.label}, ${p.squareCatalogObjectId},
         ${p.priceCents}, ${p.depositPct}, ${p.sortOrder}, ${p.isActive})
      ON CONFLICT (center_code, product_kind, square_catalog_object_id)
      DO UPDATE SET
        label       = EXCLUDED.label,
        price_cents = EXCLUDED.price_cents,
        deposit_pct = EXCLUDED.deposit_pct,
        sort_order  = EXCLUDED.sort_order,
        is_active   = EXCLUDED.is_active
        -- NOTE: qamf_web_offer_id is intentionally NOT updated here;
        --       it is managed exclusively via the admin endpoint.
      RETURNING id, center_code, product_kind, label, price_cents, is_active
    `;
    const row = result[0];
    const price = `$${(row.price_cents / 100).toFixed(2)}`;
    console.log(
      `  [${row.is_active ? "ACTIVE" : "stub "}] id=${String(row.id).padStart(4)} ${row.center_code} ${row.product_kind.padEnd(16)} ${price.padStart(7)}  "${row.label}"`,
    );
  }

  console.log(`\nDone. ${products.length} rows upserted.`);
  console.log("\nNext steps:");
  console.log("  1. Call GET /api/bowling/v2/offers?centerId=9172 to enumerate QAMF web offer IDs");
  console.log("  2. For each open product, POST to /api/admin/bowling/v2/square-products with");
  console.log('     { isActive: true, qamfWebOfferId: <id> } to activate it');
  console.log("  3. Activate shoe rental when pricing confirmed:");
  console.log(
    `     POST /api/admin/bowling/v2/square-products`,
  );
  console.log(
    `       centerCode: TXBSQN0FEKQ11  productKind: addon_shoe`,
  );
  console.log(
    `       squareCatalogObjectId: ${SHOE_VAR_ID}  priceCents: 500  isActive: true`,
  );
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
