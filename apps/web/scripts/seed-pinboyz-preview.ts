/**
 * Seed PinBoyz (Old Time Lanes) experiences at HeadPinz Fort Myers —
 * PREVIEW rows: is_active = FALSE so the live flows never list them; only
 * the tier-switcher preview branch (?preview=pinboyz include) reads them.
 *
 * QAMF web offer 176 "Old Time Lanes API" (owner 2026-07-26), Time options:
 *   1402 = 60 min · 1403 = 90 min · 1404 = 120 min
 * Pricing "follows same pricing as VIP" (owner) — items + duration options
 * are copied from the FM vip-mon-thur / vip-fri-sun rows (primary lane item
 * only, no chips & salsa), with a PinBoyz label override.
 *
 * Idempotent — re-running refreshes the rows. Remove/replace when the
 * lane-type enum migration lands and PinBoyz goes GA.
 *
 * Usage (from a checkout of apps/web that has .env.local):
 *   npx tsx scripts/seed-pinboyz-preview.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { neon } from "@neondatabase/serverless";

try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  /* rely on env */
}

const FM = "TXBSQN0FEKQ11";
const PINBOYZ_WEB_OFFER = 176;
const OPTION_BY_MINUTES: Record<number, number> = { 60: 1402, 90: 1403, 120: 1404 };

const MIRRORS = [
  {
    srcSlug: "vip-mon-thur",
    slug: "pinboyz-mon-thur",
    label: "PinBoyz Mon–Thur",
    description:
      "Reserve an old-time lane by the hour — Monday through Thursday. Bowling the way it started.",
  },
  {
    srcSlug: "vip-fri-sun",
    slug: "pinboyz-fri-sun",
    label: "PinBoyz Fri–Sun",
    description:
      "Reserve an old-time lane by the hour — Friday through Sunday. Bowling the way it started.",
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sql = neon(url);

  for (const m of MIRRORS) {
    const [src] = await sql`SELECT * FROM bowling_experiences WHERE slug = ${m.srcSlug}`;
    if (!src) {
      console.log(`✗ source ${m.srcSlug} not found — skipped`);
      continue;
    }

    const [exp] = await sql`
      INSERT INTO bowling_experiences
        (slug, label, kind, is_vip, description, sort_order, is_active, days_of_week)
      VALUES
        (${m.slug}, ${m.label}, 'hourly', FALSE, ${m.description},
         ${(src.sort_order as number) + 15}, FALSE, ${src.days_of_week})
      ON CONFLICT (slug) DO UPDATE SET
        label        = EXCLUDED.label,
        description  = EXCLUDED.description,
        days_of_week = EXCLUDED.days_of_week,
        sort_order   = EXCLUDED.sort_order,
        is_active    = FALSE
      RETURNING id
    `;
    const expId = exp.id as number;

    await sql`
      INSERT INTO bowling_experience_offers
        (experience_id, center_code, qamf_web_offer_id, qamf_option_type, qamf_option_id, is_active)
      VALUES (${expId}, ${FM}, ${PINBOYZ_WEB_OFFER}, 'Time', ${OPTION_BY_MINUTES[90]}, TRUE)
      ON CONFLICT (experience_id, center_code) DO UPDATE SET
        qamf_web_offer_id = EXCLUDED.qamf_web_offer_id,
        qamf_option_type  = EXCLUDED.qamf_option_type,
        qamf_option_id    = EXCLUDED.qamf_option_id,
        is_active         = TRUE
    `;

    // Primary lane-rental item only (sort_order 0) — VIP's chips & salsa
    // bundle item is NOT part of PinBoyz.
    await sql`DELETE FROM bowling_experience_items WHERE experience_id = ${expId}`;
    const srcItems = await sql`
      SELECT square_product_id, square_catalog_object_id, quantity
      FROM bowling_experience_items
      WHERE experience_id = ${src.id}
        AND sort_order = 0
        AND (center_code = ${FM} OR center_code IS NULL)
    `;
    for (const it of srcItems) {
      await sql`
        INSERT INTO bowling_experience_items
          (experience_id, square_product_id, square_catalog_object_id,
           quantity, label_override, sort_order, center_code)
        VALUES (${expId}, ${it.square_product_id}, ${it.square_catalog_object_id},
                ${it.quantity}, 'PinBoyz Old Time Lanes', 0, ${FM})
      `;
    }

    // Duration options: VIP's FM rows verbatim (labels, multipliers, price
    // override products) with the qamf_option_id remapped to offer 176's.
    await sql`
      DELETE FROM bowling_experience_duration_options
      WHERE experience_id = ${expId} AND center_code = ${FM}
    `;
    const srcOpts = await sql`
      SELECT duration_minutes, label, square_multiplier, sort_order, override_square_product_id
      FROM bowling_experience_duration_options
      WHERE experience_id = ${src.id} AND center_code = ${FM}
      ORDER BY sort_order
    `;
    let optCount = 0;
    for (const o of srcOpts) {
      const optId = OPTION_BY_MINUTES[o.duration_minutes as number];
      if (!optId) {
        console.log(`  ! no offer-176 option for ${o.duration_minutes} min — skipped`);
        continue;
      }
      await sql`
        INSERT INTO bowling_experience_duration_options
          (experience_id, center_code, qamf_option_id, duration_minutes,
           label, square_multiplier, sort_order, override_square_product_id)
        VALUES (${expId}, ${FM}, ${optId}, ${o.duration_minutes},
                ${o.label}, ${o.square_multiplier}, ${o.sort_order}, ${o.override_square_product_id})
      `;
      optCount++;
    }

    console.log(
      `✓ ${m.slug} (id=${expId}) ← ${m.srcSlug}: offer ${PINBOYZ_WEB_OFFER}, ` +
        `${srcItems.length} item(s), ${optCount} duration option(s), is_active=FALSE`,
    );
  }

  // Sanity: show what the preview include will return.
  const check = await sql`
    SELECT e.slug, e.is_active, e.days_of_week, eo.qamf_web_offer_id, eo.qamf_option_id
    FROM bowling_experiences e
    JOIN bowling_experience_offers eo ON eo.experience_id = e.id AND eo.center_code = ${FM}
    WHERE e.slug LIKE 'pinboyz-%'
  `;
  console.log("\nSeeded rows:", JSON.stringify(check, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
