/**
 * Backfill combo_special_id on historical VIP combo legs.
 *
 * Context: the Ultimate VIP Experience ("race-bowl") combo books as TWO
 * bowling_reservations rows — a `race` leg and an `open` bowling leg — that
 * share ONE square_dayof_order_id. The combo_special_id column was added
 * after the combo launched (2026-06-11), so rows booked before the deploy
 * have it NULL and don't surface in the reservations portal's VIP view.
 *
 * Heuristic (safe): a single square_dayof_order_id that carries BOTH a `race`
 * leg AND a bowling (`open`/`kbf`) leg is a combo — only the combo flow
 * consolidates racing + bowling into one Square order. Regular bookings get
 * separate orders, so they never match.
 *
 * Usage (from apps/web):
 *   node scripts/backfill-combo-special-id.mjs           # dry run — reports only
 *   node scripts/backfill-combo-special-id.mjs --apply   # writes combo_special_id
 *
 * Requires DATABASE_URL in apps/web/.env.local. The --apply path WRITES to the
 * production reservations DB — get explicit approval before running it.
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";

const APPLY = process.argv.includes("--apply");
const COMBO_ID = "race-bowl"; // the only combo special today

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/DATABASE_URL\s*=\s*"?([^"\n]+)"?/);
  if (!m) throw new Error("DATABASE_URL not found in env or .env.local");
  return m[1];
}

async function main() {
  const sql = neon(loadDatabaseUrl());

  // Day-of orders that have BOTH a race leg and a bowling leg, with at least
  // one leg still missing combo_special_id.
  const candidates = await sql`
    SELECT square_dayof_order_id AS order_id,
           array_agg(DISTINCT product_kind ORDER BY product_kind) AS kinds,
           array_agg(id ORDER BY id) AS ids,
           count(*) FILTER (WHERE combo_special_id IS NULL) AS missing
    FROM bowling_reservations
    WHERE square_dayof_order_id IS NOT NULL
    GROUP BY square_dayof_order_id
    HAVING bool_or(product_kind = 'race')
       AND bool_or(product_kind IN ('open', 'kbf'))
       AND count(*) FILTER (WHERE combo_special_id IS NULL) > 0
    ORDER BY max(inserted_at) DESC
  `;

  if (!candidates.length) {
    console.log("No combo legs need backfilling. ✅");
    return;
  }

  console.log(`Found ${candidates.length} combo order(s) with leg(s) missing combo_special_id:\n`);
  for (const c of candidates) {
    console.log(
      `  order ${c.order_id} · kinds=[${c.kinds.join(", ")}] · rows=[${c.ids.join(", ")}] · ${c.missing} missing`,
    );
  }

  if (!APPLY) {
    console.log(
      `\nDry run — no changes written. Re-run with --apply to set combo_special_id='${COMBO_ID}'.`,
    );
    return;
  }

  let updated = 0;
  for (const c of candidates) {
    const res = await sql`
      UPDATE bowling_reservations
      SET combo_special_id = ${COMBO_ID}
      WHERE square_dayof_order_id = ${c.order_id}
        AND combo_special_id IS NULL
      RETURNING id
    `;
    updated += res.length;
  }
  console.log(`\n✅ Backfilled combo_special_id='${COMBO_ID}' on ${updated} row(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
