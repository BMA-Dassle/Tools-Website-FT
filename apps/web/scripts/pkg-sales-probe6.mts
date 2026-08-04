/** READ-ONLY probe #6: dollars.
 *  1. VIP combos — actual charged: SUM(total_cents) across legs per combo × source, split canceled.
 *  2. sales_log UQ/Rookie — total_usd coverage + sums (cross-check vs list-price math).
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

console.log("== 1. VIP combo dollars (sum of leg total_cents per booking group) ==");
const vip = await q`
  WITH legs AS (
    SELECT combo_special_id, COALESCE(booking_source, 'web') AS src, status,
           total_cents, product_kind, player_count, promo_savings_cents,
           COALESCE(square_deposit_order_id, 'row-' || id::text) AS grp
    FROM bowling_reservations
    WHERE combo_special_id IS NOT NULL
  ), grouped AS (
    SELECT combo_special_id, grp, MAX(src) AS src,
           BOOL_OR(status IN ('cancelled', 'canceled', 'refunded')) AS canceled,
           SUM(total_cents)::bigint AS booking_cents,
           SUM(COALESCE(promo_savings_cents, 0))::bigint AS promo_cents,
           MAX(CASE WHEN product_kind = 'open' THEN player_count END) AS players
    FROM legs GROUP BY 1, 2
  )
  SELECT combo_special_id, src, canceled,
         COUNT(*)::int AS bookings, COALESCE(SUM(players), 0)::int AS guests,
         ROUND(SUM(booking_cents) / 100.0, 2) AS dollars,
         ROUND(SUM(promo_cents) / 100.0, 2) AS promo_dollars
  FROM grouped GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
for (const r of vip as Array<Record<string, unknown>>)
  console.log(
    `  ${r.combo_special_id}  src=${r.src}  canceled=${r.canceled}  bookings=${r.bookings}  guests=${r.guests}  $${r.dollars}  (promo comped $${r.promo_dollars})`,
  );

console.log("\n== 2. sales_log UQ/Rookie total_usd coverage (bill totals, cross-check only) ==");
const cov = await q`
  SELECT CASE WHEN package_id ILIKE 'ultimate-qualifier%' THEN 'UQ' ELSE 'Rookie' END AS fam,
         booking_type,
         COUNT(*)::int AS rows,
         COUNT(total_usd)::int AS with_total,
         ROUND(COALESCE(SUM(total_usd), 0), 2) AS sum_usd
  FROM sales_log
  WHERE package_id ILIKE 'ultimate-qualifier%' OR package_id ILIKE 'rookie-pack%'
  GROUP BY 1, 2 ORDER BY 1, 2`;
for (const r of cov as Array<Record<string, unknown>>)
  console.log(`  ${r.fam}  type=${r.booking_type}  rows=${r.rows}  with_total=${r.with_total}  sum=$${r.sum_usd}`);

console.log("\n== 3. avg VIP booking $ sanity (per booking, active only) ==");
const avg = await q`
  WITH legs AS (
    SELECT combo_special_id, COALESCE(square_deposit_order_id, 'row-' || id::text) AS grp,
           SUM(total_cents)::bigint AS cents,
           MAX(CASE WHEN product_kind = 'open' THEN player_count END) AS players,
           BOOL_OR(status IN ('cancelled', 'canceled')) AS canceled
    FROM bowling_reservations WHERE combo_special_id IS NOT NULL
    GROUP BY 1, 2
  )
  SELECT combo_special_id, ROUND(AVG(cents / 100.0), 2) AS avg_booking,
         ROUND(AVG(cents / NULLIF(players, 0) / 100.0), 2) AS avg_pp
  FROM legs WHERE NOT canceled GROUP BY 1`;
console.log(JSON.stringify(avg));
