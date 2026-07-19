/**
 * Seed the two World Cup VIP Bowling experiences (2026 knockout rounds,
 * July 4–19) at BOTH HeadPinz centers. Standalone on purpose — the main
 * seed-bowling-experiences.ts stays untouched.
 *
 * Safe to re-run — every write is an upsert / idempotent delete+insert
 * scoped to the world-cup experiences. NEVER touches other experiences'
 * rows (see the offer upsert note below).
 *
 * Usage:
 *   npx tsx scripts/seed-world-cup-vip.ts
 *
 * ── REQUIRED INPUTS (script hard-fails until they're filled in) ────────────
 *
 *  1. QAMF ids — DONE, ALL FOUR OFFERS LIVE-VERIFIED at both centers (FM
 *     2026-07-03, Naples 2026-07-06 after ops fixed its lane mapping): each
 *     offer created a kickoff-time test hold on a VIP lane (FM lane 7;
 *     Naples lanes 25/26) and was deleted clean. See the QAMF constant below.
 *     Nothing QAMF-side remains before launch at either center.
 *
 *  2. DEDICATED mode only: TWO Square catalog variation ids for the item
 *     "World Cup VIP Match Window (2.5 Hrs)" (create in Square Dashboard,
 *     present at all locations, same category/tax setup as the 1.5-hr VIP
 *     item BESYYLCKLOVD7YE4GYJU24HR):
 *       variation "Mon–Thur" $112.50 → WC_CAT_MON_THUR
 *       variation "Fri–Sun"  $137.50 → WC_CAT_FRI_SUN
 *
 * ── PRICING MODES (owner picks at seed time) ───────────────────────────────
 *
 *  DEDICATED (default, recommended): one self-describing line per lane
 *  ("World Cup VIP Match Window") — staff at lane-open can't misread it as a
 *  90-min lane, the confirmation email's experience label reads right, and
 *  World Cup revenue is directly visible in Square/QBO. Needs the Square
 *  catalog item above.
 *
 *  FALLBACK (`USE_DEDICATED_CATALOG_ITEM = false`): zero Square ops — bundles
 *  the two EXISTING VIP rate items (1.5-hr + 1-hr) so each lane rings
 *  $67.50 + $45 = $112.50 Mon–Thu ($82.50 + $55 = $137.50 Fri–Sun). Same
 *  charge math (verified against BowlingOfferStep.buildLineItems: primary
 *  item × lanes × 1, non-primary items × lanes), two-line receipt.
 *
 * ── What it writes ─────────────────────────────────────────────────────────
 *
 *  bowling_square_products   4 rows (DEDICATED mode only; both centers × 2)
 *  bowling_experiences       world-cup-vip-mon-thur (days Mon–Thu, sort 60)
 *                            world-cup-vip-fri-sun  (days Fri–Sun, sort 61)
 *                            — both labeled "World Cup VIP Bowling", VIP, hourly
 *  bowling_experience_offers 4 rows (2 experiences × 2 centers), each carrying
 *                            the 150-min qamf_option_id ON THE OFFER ROW
 *  bowling_experience_items  per experience: window rate item(s) + the $0
 *                            "VIP Chips & Salsa" (LHZXWYO72N5QFX4CGYKRVPZX —
 *                            already in KITCHEN_CATALOG_IDS, fires to KDS)
 *
 *  DELIBERATELY NO bowling_experience_duration_options rows: with zero
 *  duration options the offer step renders no duration picker and books with
 *  the offer row's qamf_option_id — the Open-Pkg-Duration-Bug-safe pattern
 *  (see tasks/lessons.md "Fixed-duration open packages").
 *
 * ── After the tournament (July 19 17:30 ET) ────────────────────────────────
 *  Surfaces self-hide via the fixture window. DB kill:
 *    UPDATE bowling_experiences SET is_active = FALSE WHERE slug LIKE 'world-cup-%';
 */

import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── .env.local loader (same as seed-bowling-experiences.ts) ─────────────────
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
  /* rely on env */
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// ── Center codes ─────────────────────────────────────────────────────────────
const FM = "TXBSQN0FEKQ11";
const NAPLES = "PPTR5G2N0QXF7";

// ── Pricing mode ─────────────────────────────────────────────────────────────
// LAUNCH 2026-07-06 (owner: "get it live for tonight's game"): FALLBACK mode —
// zero Square catalog ops, each lane rings the two existing VIP rate items.
// To upgrade later: create the "World Cup VIP Match Window" item in Square,
// fill WC_CAT_* below, flip this to true, re-run the seed (idempotent — items
// are replaced per experience).
const USE_DEDICATED_CATALOG_ITEM = false;

// ── Square catalog object IDs ────────────────────────────────────────────────
// DEDICATED mode: fill these two in from the Square Dashboard.
const WC_CAT_MON_THUR = "REPLACE_ME_MON_THUR_VARIATION_ID"; // $112.50/lane
const WC_CAT_FRI_SUN = "REPLACE_ME_FRI_SUN_VARIATION_ID"; // $137.50/lane

// Existing catalog ids (FALLBACK mode rate items + the chips comp).
const HOURLY_1_5_MON_VIP = "BESYYLCKLOVD7YE4GYJU24HR"; // $67.50/lane
const HOURLY_1_MON_VIP = "PI67DZQJVGR5EIXEWLB2ELOJ"; // $45.00/lane
const HOURLY_1_5_FRI_VIP = "UFD6XVXU6GKCIRCLRUFLSKMJ"; // $82.50/lane
const HOURLY_1_FRI_VIP = "OSOZ7RJ6WW7G4CEFL55U7LXF"; // $55.00/lane
const CHIPS_SALSA = "LHZXWYO72N5QFX4CGYKRVPZX"; // $0.00 comp

// ── QAMF web offers + 150-min Time options ───────────────────────────────────
// DEDICATED World Cup web offers (owner 7/3) — separate from the shared VIP
// offers (155/159/119/125) because of the 2.5-hr duration. Each offer also
// carries a 180-min option we deliberately don't use.
//
// ALL FOUR LIVE-VERIFIED end-to-end (kickoff-time test hold → VIP lane →
// deleted clean): FM 175/174 on 2026-07-03 (lane 7); Naples 141/139 on
// 2026-07-06 after ops fixed the Naples lane mapping (lanes 26/25 — the
// earlier "LanesNotAvailable" 409s are resolved). QAMF-side setup is DONE
// at both centers.
const QAMF = {
  monThur: {
    fm: { webOfferId: 175, optionId: 1397 }, // HeadPinz Fort Myers — World Cup Mon–Thur, 150 min
    naples: { webOfferId: 141, optionId: 1125 }, // HeadPinz Naples — World Cup Mon–Thur, 150 min
  },
  friSun: {
    fm: { webOfferId: 174, optionId: 1389 }, // HeadPinz Fort Myers — World Cup Fri–Sun, 150 min
    naples: { webOfferId: 139, optionId: 1109 }, // HeadPinz Naples — World Cup Fri–Sun, 150 min
  },
};

// ── Input validation (fail loud, never seed half-configured rows) ───────────
function validateInputs(): void {
  const problems: string[] = [];
  for (const [band, centers] of Object.entries(QAMF)) {
    for (const [center, cfg] of Object.entries(centers)) {
      if (!cfg.optionId) {
        problems.push(
          `QAMF.${band}.${center}.optionId is unset — read the 150-min Time option id under web offer ${cfg.webOfferId} once it activates in Conqueror`,
        );
      }
    }
  }
  if (USE_DEDICATED_CATALOG_ITEM) {
    if (WC_CAT_MON_THUR.startsWith("REPLACE_ME"))
      problems.push("WC_CAT_MON_THUR is a placeholder — create the Square variation first");
    if (WC_CAT_FRI_SUN.startsWith("REPLACE_ME"))
      problems.push("WC_CAT_FRI_SUN is a placeholder — create the Square variation first");
  }
  if (problems.length) {
    console.error("✗ seed-world-cup-vip: refusing to run — missing inputs:\n");
    for (const p of problems) console.error(`  • ${p}`);
    console.error("\nFill in the constants at the top of this script and re-run.");
    process.exit(1);
  }
}

// ── Helpers (mirroring seed-bowling-experiences.ts, with one fix) ────────────

async function upsertProduct(p: {
  centerCode: string;
  label: string;
  catalogObjectId: string;
  priceCents: number;
  sortOrder: number;
}): Promise<void> {
  await sql`
    INSERT INTO bowling_square_products
      (center_code, product_kind, label, square_catalog_object_id,
       price_cents, deposit_pct, sort_order, is_active)
    VALUES
      (${p.centerCode}, 'hourly', ${p.label}, ${p.catalogObjectId},
       ${p.priceCents}, 100, ${p.sortOrder}, TRUE)
    ON CONFLICT (center_code, product_kind, square_catalog_object_id)
    DO UPDATE SET label = EXCLUDED.label,
                  price_cents = EXCLUDED.price_cents,
                  deposit_pct = EXCLUDED.deposit_pct,
                  is_active = EXCLUDED.is_active
  `;
  console.log(`  product    ${p.centerCode === FM ? "FM    " : "Naples"} ${p.label}`);
}

async function upsertExperience(e: {
  slug: string;
  label: string;
  description: string;
  sortOrder: number;
  daysOfWeek: number[];
}): Promise<number> {
  const rows = await sql`
    INSERT INTO bowling_experiences (slug, label, kind, is_vip, description, sort_order, is_active, days_of_week)
    VALUES (${e.slug}, ${e.label}, 'hourly', TRUE,
            ${e.description}, ${e.sortOrder}, TRUE, ${e.daysOfWeek})
    ON CONFLICT (slug) DO UPDATE SET
      label        = EXCLUDED.label,
      kind         = EXCLUDED.kind,
      is_vip       = EXCLUDED.is_vip,
      description  = EXCLUDED.description,
      sort_order   = EXCLUDED.sort_order,
      is_active    = EXCLUDED.is_active,
      days_of_week = EXCLUDED.days_of_week
    RETURNING id
  `;
  const id = (rows[0] as Record<string, unknown>).id as number;
  console.log(`  experience "${e.slug}" → id=${id}`);
  return id;
}

/**
 * Offer upsert — conflicts on (experience_id, center_code), the constraint
 * the runtime helper (bowling-db upsertBowlingExperienceOffer) uses.
 *
 * DO NOT copy the main seed's upsertOffer here: it conflicts on
 * (center_code, qamf_web_offer_id) and its DO UPDATE reassigns
 * experience_id — because the world-cup experiences SHARE the VIP web
 * offers (155/159/119/125) with vip-mon-thur / vip-fri-sun, that variant
 * would STEAL the existing experiences' offer rows and break normal VIP
 * booking.
 */
async function upsertOffer(o: {
  experienceId: number;
  centerCode: string;
  qamfWebOfferId: number;
  qamfOptionId: number;
}): Promise<void> {
  await sql`
    INSERT INTO bowling_experience_offers
      (experience_id, center_code, qamf_web_offer_id, qamf_option_type, qamf_option_id, duration_minutes, is_active)
    VALUES
      (${o.experienceId}, ${o.centerCode}, ${o.qamfWebOfferId}, 'Time', ${o.qamfOptionId}, 150, TRUE)
    ON CONFLICT (experience_id, center_code) DO UPDATE SET
      qamf_web_offer_id = EXCLUDED.qamf_web_offer_id,
      qamf_option_type  = EXCLUDED.qamf_option_type,
      qamf_option_id    = EXCLUDED.qamf_option_id,
      duration_minutes  = EXCLUDED.duration_minutes,
      is_active         = EXCLUDED.is_active
  `;
  console.log(
    `              offer      ${o.centerCode === FM ? "FM    " : "Naples"} qamfOfferId=${o.qamfWebOfferId} 150-min optId=${o.qamfOptionId}`,
  );
}

async function productId(centerCode: string, catalogObjectId: string): Promise<number> {
  const rows = await sql`
    SELECT id FROM bowling_square_products
    WHERE center_code = ${centerCode}
      AND square_catalog_object_id = ${catalogObjectId}
    LIMIT 1
  `;
  if (!rows.length)
    throw new Error(
      `Product not found: ${centerCode} / ${catalogObjectId} — run seed-bowling-products.ts first`,
    );
  return (rows[0] as Record<string, unknown>).id as number;
}

async function setItems(
  experienceId: number,
  items: Array<{ catalogObjectId: string; labelOverride?: string }>,
): Promise<void> {
  await sql`DELETE FROM bowling_experience_items WHERE experience_id = ${experienceId}`;
  for (const [i, item] of items.entries()) {
    const pid = await productId(FM, item.catalogObjectId);
    await sql`
      INSERT INTO bowling_experience_items
        (experience_id, square_product_id, square_catalog_object_id,
         quantity, label_override, sort_order, center_code)
      VALUES
        (${experienceId}, ${pid}, ${item.catalogObjectId},
         1, ${item.labelOverride ?? null}, ${i}, NULL)
    `;
    console.log(`              item       ${item.catalogObjectId}  sortOrder=${i}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  validateInputs();
  console.log(
    `Seeding World Cup VIP Bowling (${USE_DEDICATED_CATALOG_ITEM ? "DEDICATED catalog item" : "FALLBACK rate bundle"} mode)\n`,
  );

  // Chips & salsa product must exist at both centers (main seed usually did
  // this already — re-ensure so this script stands alone).
  for (const center of [FM, NAPLES]) {
    await sql`
      INSERT INTO bowling_square_products
        (center_code, product_kind, label, square_catalog_object_id,
         price_cents, deposit_pct, sort_order, is_active)
      VALUES
        (${center}, 'open', 'VIP Chips & Salsa', ${CHIPS_SALSA}, 0, 100, 99, TRUE)
      ON CONFLICT (center_code, product_kind, square_catalog_object_id)
      DO UPDATE SET label = EXCLUDED.label, is_active = EXCLUDED.is_active
    `;
  }
  console.log("  Ensured VIP Chips & Salsa product (both centers)\n");

  if (USE_DEDICATED_CATALOG_ITEM) {
    console.log("── World Cup window products");
    for (const center of [FM, NAPLES]) {
      await upsertProduct({
        centerCode: center,
        label: "World Cup VIP Match Window (Mon–Thur)",
        catalogObjectId: WC_CAT_MON_THUR,
        priceCents: 11250,
        sortOrder: 24,
      });
      await upsertProduct({
        centerCode: center,
        label: "World Cup VIP Match Window (Fri–Sun)",
        catalogObjectId: WC_CAT_FRI_SUN,
        priceCents: 13750,
        sortOrder: 25,
      });
    }
    console.log("");
  }

  const description =
    "Watch the match on the NeoVerse LED video walls from the semi-private VIP suite — " +
    "a 2.5-hour lane starting at kickoff, chips & salsa included. Shoes not included.";

  // ── World Cup VIP — Mon-Thur band ($112.50/lane) ──────────────────────────
  console.log("── World Cup VIP Mon-Thur");
  const monThurId = await upsertExperience({
    slug: "world-cup-vip-mon-thur",
    label: "World Cup VIP Bowling",
    description,
    sortOrder: 60,
    daysOfWeek: [1, 2, 3, 4],
  });
  await upsertOffer({
    experienceId: monThurId,
    centerCode: FM,
    qamfWebOfferId: QAMF.monThur.fm.webOfferId,
    qamfOptionId: QAMF.monThur.fm.optionId,
  });
  await upsertOffer({
    experienceId: monThurId,
    centerCode: NAPLES,
    qamfWebOfferId: QAMF.monThur.naples.webOfferId,
    qamfOptionId: QAMF.monThur.naples.optionId,
  });
  await setItems(
    monThurId,
    USE_DEDICATED_CATALOG_ITEM
      ? [
          { catalogObjectId: WC_CAT_MON_THUR },
          { catalogObjectId: CHIPS_SALSA, labelOverride: "VIP Chips & Salsa" },
        ]
      : [
          { catalogObjectId: HOURLY_1_5_MON_VIP },
          { catalogObjectId: HOURLY_1_MON_VIP },
          { catalogObjectId: CHIPS_SALSA, labelOverride: "VIP Chips & Salsa" },
        ],
  );

  // ── World Cup VIP — Fri-Sun band ($137.50/lane) ───────────────────────────
  console.log("\n── World Cup VIP Fri-Sun");
  const friSunId = await upsertExperience({
    slug: "world-cup-vip-fri-sun",
    label: "World Cup VIP Bowling",
    description,
    sortOrder: 61,
    daysOfWeek: [5, 6, 0],
  });
  await upsertOffer({
    experienceId: friSunId,
    centerCode: FM,
    qamfWebOfferId: QAMF.friSun.fm.webOfferId,
    qamfOptionId: QAMF.friSun.fm.optionId,
  });
  await upsertOffer({
    experienceId: friSunId,
    centerCode: NAPLES,
    qamfWebOfferId: QAMF.friSun.naples.webOfferId,
    qamfOptionId: QAMF.friSun.naples.optionId,
  });
  await setItems(
    friSunId,
    USE_DEDICATED_CATALOG_ITEM
      ? [
          { catalogObjectId: WC_CAT_FRI_SUN },
          { catalogObjectId: CHIPS_SALSA, labelOverride: "VIP Chips & Salsa" },
        ]
      : [
          { catalogObjectId: HOURLY_1_5_FRI_VIP },
          { catalogObjectId: HOURLY_1_FRI_VIP },
          { catalogObjectId: CHIPS_SALSA, labelOverride: "VIP Chips & Salsa" },
        ],
  );

  // Deliberately NO duration-option rows (load-bearing): zero options ⇒ no
  // duration picker ⇒ the offer row's 150-min qamf_option_id is used.
  await sql`
    DELETE FROM bowling_experience_duration_options
    WHERE experience_id IN (${monThurId}, ${friSunId})
  `;
  console.log("\n  Cleared duration options (fixed 150-min window rides the offer rows)");

  console.log(`
Done. Verify:
  GET /api/bowling/v2/experiences?centerCode=${FM}
  GET /api/bowling/v2/experiences?centerCode=${NAPLES}
  → both world-cup rows present, offers carry the 150-min qamf_option_id,
    durationOptions empty.

Launch reminders:
  • Vercel env: NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED=false until the
    Naples LED wall is verified (owner 7/3) — then flip + redeploy.
  • Post-tournament kill:
      UPDATE bowling_experiences SET is_active = FALSE WHERE slug LIKE 'world-cup-%';
`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
