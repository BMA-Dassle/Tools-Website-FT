/**
 * Seed bowling_experiences, bowling_experience_offers,
 * bowling_experience_items, and bowling_experience_duration_options.
 *
 * Safe to re-run — all operations are upserts / idempotent deletes+inserts
 * scoped to the experience being seeded.
 *
 * Usage:
 *   npx tsx scripts/seed-bowling-experiences.ts
 *
 * Run AFTER seed-bowling-products.ts (square products must exist first).
 *
 * ── Experiences seeded ────────────────────────────────────────────
 *
 *  slug                  kind    vip   QAMF offers
 *  ─────────────────────────────────────────────────────────────────
 *  kbf-regular           kbf     no    FM:152 / Naples:122
 *  kbf-vip               kbf     yes   FM:153 / Naples:123
 *  regular-mon-thur      hourly  no    FM:154 / Naples:118  (1.5hr + 2hr)
 *  vip-mon-thur          hourly  yes   FM:155 / Naples:119  (1.5hr + 2hr)
 *  fun-4-all             open    no    FM:156 / Naples:120
 *  fun-4-all-vip         open    yes   FM:157 / Naples:121
 *  regular-fri-sun       hourly  no    stub — no offers yet (is_active=false)
 *  vip-fri-sun           hourly  yes   stub — no offers yet (is_active=false)
 *
 * ── Items (bundled Square products) ──────────────────────────────
 *  KBF:              no base charge (free)
 *  KBF VIP:          + VIP Chips & Salsa ($0, FM only)
 *  Hourly Regular:   1.5 Hr Mon-Thur lane rate (×multiplier per duration)
 *  Hourly VIP:       1.5 Hr Mon-Thur VIP lane rate (×multiplier)
 *  Fun 4 All:        Fun 4 All per-person rate
 *  Fun 4 All VIP:    Fun 4 All VIP per-person rate + Chips & Salsa (FM only)
 *
 * ── Duration options (hourly only) ───────────────────────────────
 *  1.5 Hours → QAMF 90-min option, square_multiplier=1
 *  2 Hours   → QAMF 120-min option, square_multiplier=2
 *             (2 hours is charged as 2 × the 1.5hr lane rate)
 */

import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── .env.local loader ────────────────────────────────────────────────────────
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
} catch { /* rely on env */ }

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

const sql = neon(DATABASE_URL);

// ── Center codes ─────────────────────────────────────────────────────────────
const FM     = "TXBSQN0FEKQ11";
const NAPLES = "PPTR5G2N0QXF7";

// ── Square catalog object IDs ─────────────────────────────────────────────────
const CAT = {
  FUN_4_ALL:          "TOKSMRAUZSSCXSTJHSZ22TTU",  // $15.99/person
  FUN_4_ALL_VIP:      "RA3DBEYZVIEKIHON7KVMNRMQ",  // $17.99/person
  HOURLY_1_5_MON:     "43HJHFSYZNB42NWB2CM7UKOV",  // $45.00/lane (1.5hr Mon-Thu)
  HOURLY_1_5_MON_VIP: "BESYYLCKLOVD7YE4GYJU24HR",  // $67.50/lane
  CHIPS_SALSA:        "LHZXWYO72N5QFX4CGYKRVPZX",  // $0.00 comp (FM only)
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function upsertExperience(e: {
  slug: string; label: string; kind: string; isVip: boolean;
  description?: string; sortOrder: number; isActive: boolean;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO bowling_experiences (slug, label, kind, is_vip, description, sort_order, is_active)
    VALUES (${e.slug}, ${e.label}, ${e.kind}, ${e.isVip},
            ${e.description ?? null}, ${e.sortOrder}, ${e.isActive})
    ON CONFLICT (slug) DO UPDATE SET
      label       = EXCLUDED.label,
      kind        = EXCLUDED.kind,
      is_vip      = EXCLUDED.is_vip,
      description = EXCLUDED.description,
      sort_order  = EXCLUDED.sort_order,
      is_active   = EXCLUDED.is_active
    RETURNING id, slug, is_active
  `;
  const row = rows[0] as Record<string, unknown>;
  const active = row.is_active ? "ACTIVE" : "stub ";
  console.log(`  [${active}] experience  "${e.slug}" → id=${row.id}`);
  return row.id as number;
}

async function upsertOffer(o: {
  experienceId: number; centerCode: string; qamfWebOfferId: number;
  qamfOptionType?: string; qamfOptionId?: number;
}): Promise<void> {
  await sql`
    INSERT INTO bowling_experience_offers
      (experience_id, center_code, qamf_web_offer_id, qamf_option_type, qamf_option_id, is_active)
    VALUES
      (${o.experienceId}, ${o.centerCode}, ${o.qamfWebOfferId},
       ${o.qamfOptionType ?? null}, ${o.qamfOptionId ?? null}, TRUE)
    ON CONFLICT (center_code, qamf_web_offer_id) DO UPDATE SET
      experience_id    = EXCLUDED.experience_id,
      qamf_option_type = EXCLUDED.qamf_option_type,
      qamf_option_id   = EXCLUDED.qamf_option_id,
      is_active        = EXCLUDED.is_active
  `;
  const center = o.centerCode === FM ? "FM    " : "Naples";
  console.log(`              offer      ${center} qamfOfferId=${o.qamfWebOfferId}`);
}

/** Look up bowling_square_products.id by center + catalog object ID. */
async function productId(centerCode: string, catalogObjectId: string): Promise<number> {
  const rows = await sql`
    SELECT id FROM bowling_square_products
    WHERE center_code = ${centerCode}
      AND square_catalog_object_id = ${catalogObjectId}
    LIMIT 1
  `;
  if (!rows.length) throw new Error(`Product not found: ${centerCode} / ${catalogObjectId} — run seed-bowling-products.ts first`);
  return (rows[0] as Record<string, unknown>).id as number;
}

async function setItems(
  experienceId: number,
  items: Array<{
    catalogObjectId: string;
    quantity?: number;
    centerCode?: string | null;  // null = all centers
    labelOverride?: string;
    sortOrder?: number;
  }>,
): Promise<void> {
  await sql`DELETE FROM bowling_experience_items WHERE experience_id = ${experienceId}`;
  for (const [i, item] of items.entries()) {
    // We need a representative square_product_id for the FK.
    // Use FM row when center-specific, FM row as default for all-center items.
    const refCenter = item.centerCode ?? FM;
    const pid = await productId(refCenter, item.catalogObjectId);
    await sql`
      INSERT INTO bowling_experience_items
        (experience_id, square_product_id, square_catalog_object_id,
         quantity, label_override, sort_order, center_code)
      VALUES
        (${experienceId}, ${pid}, ${item.catalogObjectId},
         ${item.quantity ?? 1}, ${item.labelOverride ?? null},
         ${item.sortOrder ?? i}, ${item.centerCode ?? null})
    `;
    const scope = item.centerCode ? `(${item.centerCode} only)` : "(all centers)";
    console.log(`              item       ${item.catalogObjectId}  qty=${item.quantity ?? 1}  ${scope}`);
  }
}

async function setDurationOptions(
  experienceId: number,
  centerCode: string,
  options: Array<{ qamfOptionId: number; durationMinutes: number; label: string; squareMultiplier: number }>,
): Promise<void> {
  await sql`
    DELETE FROM bowling_experience_duration_options
    WHERE experience_id = ${experienceId} AND center_code = ${centerCode}
  `;
  for (const [i, opt] of options.entries()) {
    await sql`
      INSERT INTO bowling_experience_duration_options
        (experience_id, center_code, qamf_option_id, duration_minutes, label, square_multiplier, sort_order)
      VALUES
        (${experienceId}, ${centerCode}, ${opt.qamfOptionId}, ${opt.durationMinutes},
         ${opt.label}, ${opt.squareMultiplier}, ${i})
    `;
    const center = centerCode === FM ? "FM    " : "Naples";
    console.log(`              duration   ${center} optId=${opt.qamfOptionId}  ${opt.label}  ×${opt.squareMultiplier}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Ensuring experience catalog schema...");
  // Trigger ensureBowlingSchema via a known endpoint doesn't work in scripts;
  // run the relevant CREATE/ALTER statements inline.
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
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS bedo_exp ON bowling_experience_duration_options(experience_id, center_code)`;
  await sql`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS square_catalog_object_id TEXT`;
  await sql`ALTER TABLE bowling_experience_items ADD COLUMN IF NOT EXISTS center_code TEXT`;

  console.log("Schema ready.\n");

  // ── Ensure Chips & Salsa product exists at both centers ──────────────────
  // present_at_all_locations in Square — same catalog ID at FM and Naples.
  for (const center of [FM, NAPLES]) {
    await sql`
      INSERT INTO bowling_square_products
        (center_code, product_kind, label, square_catalog_object_id,
         price_cents, deposit_pct, sort_order, is_active)
      VALUES
        (${center}, 'open', 'VIP Chips & Salsa', ${CAT.CHIPS_SALSA}, 0, 100, 99, TRUE)
      ON CONFLICT (center_code, product_kind, square_catalog_object_id)
      DO UPDATE SET label = EXCLUDED.label, is_active = EXCLUDED.is_active
    `;
  }
  console.log("  Ensured VIP Chips & Salsa product (both centers)\n");

  // ── 1. KBF Regular ──────────────────────────────────────────────────────────
  console.log("── KBF Regular");
  const kbfRegId = await upsertExperience({
    slug: "kbf-regular", label: "Kids Bowl Free", kind: "kbf",
    isVip: false, sortOrder: 10, isActive: true,
    description: "2 free games per registered KBF member",
  });
  await upsertOffer({ experienceId: kbfRegId, centerCode: FM,     qamfWebOfferId: 152, qamfOptionType: "Game", qamfOptionId: 908 });
  await upsertOffer({ experienceId: kbfRegId, centerCode: NAPLES, qamfWebOfferId: 122, qamfOptionType: "Game", qamfOptionId: 728 });
  // No base items — KBF is free

  // ── 2. KBF VIP ──────────────────────────────────────────────────────────────
  console.log("\n── KBF VIP");
  const kbfVipId = await upsertExperience({
    slug: "kbf-vip", label: "Kids Bowl Free VIP", kind: "kbf",
    isVip: true, sortOrder: 11, isActive: true,
    description: "2 free games + VIP lane access",
  });
  await upsertOffer({ experienceId: kbfVipId, centerCode: FM,     qamfWebOfferId: 153, qamfOptionType: "Game", qamfOptionId: 914 });
  await upsertOffer({ experienceId: kbfVipId, centerCode: NAPLES, qamfWebOfferId: 123, qamfOptionType: "Game", qamfOptionId: 734 });
  // KBF VIP: no Chips & Salsa — free bowling only

  // ── 3. Regular Mon-Thur ─────────────────────────────────────────────────────
  console.log("\n── Regular Mon-Thur");
  const regMonId = await upsertExperience({
    slug: "regular-mon-thur", label: "Regular Mon–Thur", kind: "hourly",
    isVip: false, sortOrder: 20, isActive: true,
    description: "Hourly lane rental — Monday through Thursday",
  });
  await upsertOffer({ experienceId: regMonId, centerCode: FM,     qamfWebOfferId: 154, qamfOptionType: "Time" });
  await upsertOffer({ experienceId: regMonId, centerCode: NAPLES, qamfWebOfferId: 118, qamfOptionType: "Time" });
  await setItems(regMonId, [
    { catalogObjectId: CAT.HOURLY_1_5_MON, quantity: 1 },  // all centers; multiplied by duration choice
  ]);
  await setDurationOptions(regMonId, FM,     [ { qamfOptionId: 1227, durationMinutes: 90,  label: "1.5 Hours", squareMultiplier: 1 }, { qamfOptionId: 1228, durationMinutes: 120, label: "2 Hours",   squareMultiplier: 2 } ]);
  await setDurationOptions(regMonId, NAPLES, [ { qamfOptionId: 939,  durationMinutes: 90,  label: "1.5 Hours", squareMultiplier: 1 }, { qamfOptionId: 940,  durationMinutes: 120, label: "2 Hours",   squareMultiplier: 2 } ]);

  // ── 4. VIP Mon-Thur ─────────────────────────────────────────────────────────
  console.log("\n── VIP Mon-Thur");
  const vipMonId = await upsertExperience({
    slug: "vip-mon-thur", label: "VIP Mon–Thur", kind: "hourly",
    isVip: true, sortOrder: 21, isActive: true,
    description: "VIP lane rental — Monday through Thursday",
  });
  await upsertOffer({ experienceId: vipMonId, centerCode: FM,     qamfWebOfferId: 155, qamfOptionType: "Time" });
  await upsertOffer({ experienceId: vipMonId, centerCode: NAPLES, qamfWebOfferId: 119, qamfOptionType: "Time" });
  await setItems(vipMonId, [
    { catalogObjectId: CAT.HOURLY_1_5_MON_VIP, quantity: 1 },
    { catalogObjectId: CAT.CHIPS_SALSA, quantity: 1, labelOverride: "VIP Chips & Salsa" },
  ]);
  await setDurationOptions(vipMonId, FM,     [ { qamfOptionId: 1235, durationMinutes: 90,  label: "1.5 Hours", squareMultiplier: 1 }, { qamfOptionId: 1236, durationMinutes: 120, label: "2 Hours",   squareMultiplier: 2 } ]);
  await setDurationOptions(vipMonId, NAPLES, [ { qamfOptionId: 947,  durationMinutes: 90,  label: "1.5 Hours", squareMultiplier: 1 }, { qamfOptionId: 948,  durationMinutes: 120, label: "2 Hours",   squareMultiplier: 2 } ]);

  // ── 5. Fun 4 All Regular ────────────────────────────────────────────────────
  console.log("\n── Fun 4 All Regular");
  const f4aRegId = await upsertExperience({
    slug: "fun-4-all", label: "Fun 4 All", kind: "open",
    isVip: false, sortOrder: 30, isActive: true,
    description: "Unlimited bowling for one low price",
  });
  await upsertOffer({ experienceId: f4aRegId, centerCode: FM,     qamfWebOfferId: 156, qamfOptionType: "Unlimited", qamfOptionId: 156 });
  await upsertOffer({ experienceId: f4aRegId, centerCode: NAPLES, qamfWebOfferId: 120, qamfOptionType: "Unlimited", qamfOptionId: 120 });
  await setItems(f4aRegId, [
    { catalogObjectId: CAT.FUN_4_ALL, quantity: 1 },
  ]);

  // ── 6. Fun 4 All VIP ────────────────────────────────────────────────────────
  console.log("\n── Fun 4 All VIP");
  const f4aVipId = await upsertExperience({
    slug: "fun-4-all-vip", label: "Fun 4 All VIP", kind: "open",
    isVip: true, sortOrder: 31, isActive: true,
    description: "Unlimited bowling in VIP lanes",
  });
  await upsertOffer({ experienceId: f4aVipId, centerCode: FM,     qamfWebOfferId: 157, qamfOptionType: "Unlimited", qamfOptionId: 157 });
  await upsertOffer({ experienceId: f4aVipId, centerCode: NAPLES, qamfWebOfferId: 121, qamfOptionType: "Unlimited", qamfOptionId: 121 });
  await setItems(f4aVipId, [
    { catalogObjectId: CAT.FUN_4_ALL_VIP, quantity: 1 },
    { catalogObjectId: CAT.CHIPS_SALSA, quantity: 1, labelOverride: "VIP Chips & Salsa" },
  ]);

  // ── 7 & 8. Fri-Sun stubs (no QAMF offers yet) ───────────────────────────────
  console.log("\n── Regular Fri-Sun (stub)");
  await upsertExperience({
    slug: "regular-fri-sun", label: "Regular Fri–Sun", kind: "hourly",
    isVip: false, sortOrder: 22, isActive: false,
    description: "Hourly lane rental — Friday through Sunday",
  });

  console.log("\n── VIP Fri-Sun (stub)");
  const vipFriId = await upsertExperience({
    slug: "vip-fri-sun", label: "VIP Fri–Sun", kind: "hourly",
    isVip: true, sortOrder: 23, isActive: false,
    description: "VIP lane rental — Friday through Sunday",
  });
  await setItems(vipFriId, [
    { catalogObjectId: CAT.CHIPS_SALSA, quantity: 1, labelOverride: "VIP Chips & Salsa" },
  ]);

  console.log("\n✓ Done. 8 experiences seeded.");
  console.log("\nNext: add Fri-Sun QAMF offer IDs via /api/admin/bowling/v2/experiences");
  console.log("      activate shoe rental via /api/admin/bowling/v2/square-products");
}

main().catch((err) => { console.error("Seed failed:", err); process.exit(1); });
