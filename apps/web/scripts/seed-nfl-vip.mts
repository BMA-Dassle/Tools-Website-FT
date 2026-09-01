/**
 * Seed "NFL Ticket on NeoVerse" — the game-day VIP bowling package.
 *
 *   $119.95 per VIP lane (up to 6 bowlers). 3 hours of bowling, shoes,
 *   1 pizza with a topping, 10 wings with a heat and a dressing choice, and a
 *   soda pitcher. Lanes open 15 minutes before kickoff.
 *
 * REFUSES TO RUN until the Square catalog exists. The four ids below are
 * placeholders; `validateInputs()` exits non-zero on any of them, so this can
 * never seed a half-configured package that takes money and rings up nothing.
 * Fill them in, run, done — that is the entire remaining ops step.
 *
 * ── Why TWO experience rows for one $119.95 package ──────────────────────────
 * Not pricing. The Conqueror offers are DAY-BANDED and the vendor enforces it:
 * offer 175 ("Mon-Thur") answers `409 WebOfferUnavailableOpeningHours` for a
 * Sunday, probed live 2026-08-25. Offers 174 + 175 between them cover all seven
 * days, and `bowling_experience_offers` is unique on (experience_id,
 * center_code) — so two offers means two rows. Both carry identical pricing and
 * items; the guest sees one card.
 *
 * ── Why no Conqueror work was needed ─────────────────────────────────────────
 * Both offers ALREADY carry a 180-minute Time option — 1390 on 174, 1398 on 175
 * — sitting unused beside the 150s the World Cup rode. Verified live, along with
 * the fact that these offers are hard-bound to the VIP lane group (a PATCH onto
 * regular lane 20 is refused `409 LanesNotCompatible`). See
 * scripts/nfl-qamf-probe.mjs.
 *
 * ── Two traps inherited from the World Cup seed, do not "simplify" them ──────
 *  1. The offer upsert conflicts on (experience_id, center_code). The MAIN
 *     seed's variant conflicts on (center_code, qamf_web_offer_id) and its DO
 *     UPDATE reassigns experience_id — which, because these rows SHARE offers
 *     174/175 with the world-cup-* rows, would silently steal them.
 *  2. ZERO bowling_experience_duration_options rows. With no duration options
 *     the offer step renders no duration picker and books the offer row's own
 *     qamf_option_id. Adding duration rows re-opens the Open-Pkg-Duration bug.
 *
 * Usage:  npx tsx scripts/seed-nfl-vip.mts [--dry-run]
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
    if (!process.env[k]) process.env[k] = v;
  }
} catch {
  /* rely on the ambient env */
}

const DRY_RUN = process.argv.includes("--dry-run");
const FM = "TXBSQN0FEKQ11"; // HeadPinz Fort Myers

// ── Square catalog ───────────────────────────────────────────────────────────
// Create these in the Square Dashboard, then paste the VARIATION ids here.
//
//   NFL Ticket on NeoVerse (3 Hrs)   $119.95   → NFL_CAT_LANE
//   Game Day Pizza                   $0.00     → NFL_CAT_PIZZA   + Pizza Toppings
//   Game Day Wings (10)              $0.00     → NFL_CAT_WINGS   + Wing Heat, Wing Dressing
//   Game Day Soda Pitcher            $0.00     → NFL_CAT_SODA    + Soda Choice
//
// The three $0 items are what reaches the kitchen: they ride the day-of Square
// order and lane-open stamps "Lane N" into their notes. Their ids MUST also go
// into KITCHEN_CATALOG_IDS (lib/bowling-lane-open.ts) and ALLOWED_FOOD
// (app/api/bowling/v2/reservations/[id]/food/route.ts) or the kitchen never
// sees the order and the guest cannot edit it afterwards.
const NFL_CAT_LANE = "REPLACE_ME_NFL_LANE_VARIATION_ID"; // $119.95/lane
const NFL_CAT_PIZZA = "REPLACE_ME_NFL_PIZZA_VARIATION_ID"; // $0
const NFL_CAT_WINGS = "REPLACE_ME_NFL_WINGS_VARIATION_ID"; // $0
const NFL_CAT_SODA = "REPLACE_ME_NFL_SODA_VARIATION_ID"; // $0

const LANE_PRICE_CENTS = 11995;

/** Included per modifier group, and what each extra costs. */
const PIZZA_INCLUDED_TOPPINGS = 1;
const PIZZA_EXTRA_TOPPING_CENTS = 100;

// ── QAMF: offers already configured, nothing to create ───────────────────────
const QAMF = {
  "fri-sun": { webOfferId: 174, optionId: 1390 }, // Fri/Sat/Sun, 180 min
  "mon-thur": { webOfferId: 175, optionId: 1398 }, // Mon-Thu, 180 min
} as const;

const WINDOW_MINUTES = 180; // mirrors NFL_WINDOW_MINUTES in features/nfl/schedule.ts

const LABEL = "NFL Ticket on NeoVerse";
const DESCRIPTION =
  "Your game on the NeoVerse LED walls, a VIP lane for 3 hours from 15 minutes " +
  "before kickoff, shoes, a one-topping pizza, 10 wings and a soda pitcher.";

function validateInputs(): void {
  const problems: string[] = [];
  for (const [name, id] of Object.entries({
    NFL_CAT_LANE,
    NFL_CAT_PIZZA,
    NFL_CAT_WINGS,
    NFL_CAT_SODA,
  })) {
    if (id.startsWith("REPLACE_ME")) {
      problems.push(`${name} is a placeholder — create the Square item and paste its variation id`);
    }
  }
  if (!process.env.DATABASE_URL) problems.push("DATABASE_URL is not set");
  if (problems.length) {
    console.error("✗ seed-nfl-vip: refusing to run — missing inputs:\n");
    for (const p of problems) console.error(`  • ${p}`);
    console.error("\nFill in the constants at the top of this script and re-run.");
    process.exit(1);
  }
}

/**
 * LAZY on purpose. `neon()` throws the moment it is called without a
 * connection string, so building it at module scope would fire before
 * validateInputs() — and the operator would see a confusing Neon error instead
 * of "these four Square ids are still placeholders", which is the entire point
 * of the guard.
 */
let _sql: ReturnType<typeof neon> | null = null;
function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<Record<string, unknown>[]> {
  if (!_sql) _sql = neon(process.env.DATABASE_URL ?? "");
  return _sql(strings, ...values) as Promise<Record<string, unknown>[]>;
}

async function upsertProduct(p: {
  label: string;
  catalogObjectId: string;
  priceCents: number;
  sortOrder: number;
}): Promise<void> {
  if (DRY_RUN) return void console.log(`  [dry] product   ${p.label} $${p.priceCents / 100}`);
  await sql`
    INSERT INTO bowling_square_products
      (center_code, product_kind, label, square_catalog_object_id,
       price_cents, deposit_pct, sort_order, is_active)
    VALUES
      (${FM}, 'hourly', ${p.label}, ${p.catalogObjectId},
       ${p.priceCents}, 100, ${p.sortOrder}, TRUE)
    ON CONFLICT (center_code, product_kind, square_catalog_object_id)
    DO UPDATE SET label = EXCLUDED.label,
                  price_cents = EXCLUDED.price_cents,
                  deposit_pct = EXCLUDED.deposit_pct,
                  is_active = EXCLUDED.is_active
  `;
  console.log(`  product    ${p.label}  $${(p.priceCents / 100).toFixed(2)}`);
}

async function upsertExperience(e: {
  slug: string;
  sortOrder: number;
  daysOfWeek: number[];
}): Promise<number> {
  if (DRY_RUN) {
    console.log(`  [dry] experience ${e.slug}  days=${JSON.stringify(e.daysOfWeek)}`);
    return -1;
  }
  const rows = await sql`
    INSERT INTO bowling_experiences
      (slug, label, kind, is_vip, description, sort_order, is_active, days_of_week)
    VALUES
      (${e.slug}, ${LABEL}, 'hourly', TRUE, ${DESCRIPTION}, ${e.sortOrder}, TRUE, ${e.daysOfWeek})
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
  const id = rows[0].id as number;
  console.log(`  experience ${e.slug}  id=${id}  days=${JSON.stringify(e.daysOfWeek)}`);
  return id;
}

async function upsertOffer(o: {
  experienceId: number;
  qamfWebOfferId: number;
  qamfOptionId: number;
}): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [dry] offer     ${o.qamfWebOfferId} opt=${o.qamfOptionId} ${WINDOW_MINUTES}min`);
    return;
  }
  // CONFLICT TARGET IS LOAD-BEARING — see the header. Conflicting on
  // (center_code, qamf_web_offer_id) instead would reassign experience_id and
  // steal offers 174/175 from the world-cup-* rows that share them.
  await sql`
    INSERT INTO bowling_experience_offers
      (experience_id, center_code, qamf_web_offer_id, qamf_option_type,
       qamf_option_id, duration_minutes, is_active)
    VALUES
      (${o.experienceId}, ${FM}, ${o.qamfWebOfferId}, 'Time',
       ${o.qamfOptionId}, ${WINDOW_MINUTES}, TRUE)
    ON CONFLICT (experience_id, center_code) DO UPDATE SET
      qamf_web_offer_id = EXCLUDED.qamf_web_offer_id,
      qamf_option_type  = EXCLUDED.qamf_option_type,
      qamf_option_id    = EXCLUDED.qamf_option_id,
      duration_minutes  = EXCLUDED.duration_minutes,
      is_active         = EXCLUDED.is_active
  `;
  console.log(
    `  offer      qamfOfferId=${o.qamfWebOfferId} ${WINDOW_MINUTES}-min optId=${o.qamfOptionId}`,
  );
}

async function productId(catalogObjectId: string): Promise<number> {
  const rows = await sql`
    SELECT id FROM bowling_square_products
     WHERE center_code = ${FM} AND square_catalog_object_id = ${catalogObjectId}
     LIMIT 1
  `;
  if (!rows.length) throw new Error(`Product not found: ${catalogObjectId}`);
  return rows[0].id as number;
}

/** Items in sortOrder. sortOrder 0 is the PRIMARY — its label carries the
 *  matchup on the receipt (see buildNflLineItems). */
const ITEMS = [
  { catalogObjectId: NFL_CAT_LANE, included: 1, extraCents: 0 },
  { catalogObjectId: NFL_CAT_PIZZA, included: PIZZA_INCLUDED_TOPPINGS, extraCents: PIZZA_EXTRA_TOPPING_CENTS },
  { catalogObjectId: NFL_CAT_WINGS, included: 1, extraCents: 0 },
  { catalogObjectId: NFL_CAT_SODA, included: 1, extraCents: 0 },
];

async function setItems(experienceId: number): Promise<void> {
  if (DRY_RUN) return void console.log(`  [dry] items     ${ITEMS.length}`);
  await sql`DELETE FROM bowling_experience_items WHERE experience_id = ${experienceId}`;
  for (const [i, item] of ITEMS.entries()) {
    const pid = await productId(item.catalogObjectId);
    await sql`
      INSERT INTO bowling_experience_items
        (experience_id, square_product_id, square_catalog_object_id, quantity,
         label_override, sort_order, center_code,
         included_modifier_count, extra_modifier_cents)
      VALUES
        (${experienceId}, ${pid}, ${item.catalogObjectId}, 1,
         NULL, ${i}, NULL, ${item.included}, ${item.extraCents})
    `;
    console.log(
      `             item     sortOrder=${i} included=${item.included} extra=${item.extraCents}c`,
    );
  }
}

async function main() {
  validateInputs();
  console.log(`Seeding ${LABEL} — HeadPinz Fort Myers\n`);

  console.log("Products");
  await upsertProduct({ label: LABEL, catalogObjectId: NFL_CAT_LANE, priceCents: LANE_PRICE_CENTS, sortOrder: 0 });
  await upsertProduct({ label: "Game Day Pizza", catalogObjectId: NFL_CAT_PIZZA, priceCents: 0, sortOrder: 1 });
  await upsertProduct({ label: "Game Day Wings (10)", catalogObjectId: NFL_CAT_WINGS, priceCents: 0, sortOrder: 2 });
  await upsertProduct({ label: "Game Day Soda Pitcher", catalogObjectId: NFL_CAT_SODA, priceCents: 0, sortOrder: 3 });

  const bands = [
    { slug: "nfl-vip-fri-sun", band: "fri-sun" as const, daysOfWeek: [5, 6, 0], sortOrder: 70 },
    { slug: "nfl-vip-mon-thur", band: "mon-thur" as const, daysOfWeek: [1, 2, 3, 4], sortOrder: 71 },
  ];

  const ids: number[] = [];
  for (const b of bands) {
    console.log(`\n── ${b.slug}`);
    const id = await upsertExperience({ slug: b.slug, sortOrder: b.sortOrder, daysOfWeek: b.daysOfWeek });
    ids.push(id);
    await upsertOffer({
      experienceId: id,
      qamfWebOfferId: QAMF[b.band].webOfferId,
      qamfOptionId: QAMF[b.band].optionId,
    });
    await setItems(id);
  }

  if (!DRY_RUN) {
    // Deliberately NO duration-option rows — zero options means no duration
    // picker and the offer row's own 180-min option is used. Clearing rather
    // than skipping, so a re-run after a mistaken insert self-heals.
    await sql`DELETE FROM bowling_experience_duration_options WHERE experience_id = ANY(${ids})`;
    console.log(`\n  Cleared duration options (fixed ${WINDOW_MINUTES}-min window rides the offer rows)`);
  }

  console.log(`\n✓ Done. Verify: GET /api/bowling/v2/experiences?centerCode=${FM}`);
  console.log("  → both nfl-vip-* rows present, offers carry the 180-min option,");
  console.log("    zero duration options, four items each.");
  console.log("\nStill to do by hand once the Square ids are in:");
  console.log("  • add the three $0 ids to KITCHEN_CATALOG_IDS (lib/bowling-lane-open.ts)");
  console.log("  • add them to ALLOWED_FOOD (bowling/v2/reservations/[id]/food/route.ts)");
  console.log("\nTo retire the package after the season:");
  console.log("  UPDATE bowling_experiences SET is_active = FALSE WHERE slug LIKE 'nfl-vip-%';");
}

main().catch((err) => {
  console.error(`\n✗ seed-nfl-vip failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
