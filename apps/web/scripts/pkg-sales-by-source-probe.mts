/**
 * READ-ONLY probe: lifetime sales of Ultimate Qualifier, Rookie Pack, and
 * Ultimate VIP Experience — by center and purchase source (web vs kiosk).
 *
 * Sources:
 *  - sales_log            → UQ / Rookie web-funnel confirmations (package_id).
 *                           Kiosk confirmations also land here but WITHOUT a
 *                           package_id (kiosk-post-reserve doesn't forward it),
 *                           so we also sample NULL-package UQ-shaped rows.
 *  - bowling_reservations → VIP combo legs (combo_special_id race-bowl /
 *                           race-bowl-v2) with center_code + booking_source.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

console.log("══ 1. sales_log — all distinct package_id values ever seen ══");
const pkgs = (await q`
  SELECT COALESCE(package_id, '(null)') AS pkg, COUNT(*)::int AS n,
         MIN(ts)::date AS first, MAX(ts)::date AS last
  FROM sales_log
  GROUP BY 1 ORDER BY n DESC
`) as Array<Record<string, unknown>>;
for (const r of pkgs) console.log(`  ${r.pkg}  n=${r.n}  ${r.first} → ${r.last}`);

console.log("\n══ 2. sales_log — UQ + Rookie by package × location ══");
const byPkg = (await q`
  SELECT package_id, location, COUNT(*)::int AS bookings,
         COALESCE(SUM(participant_count), 0)::int AS people,
         MIN(ts)::date AS first, MAX(ts)::date AS last
  FROM sales_log
  WHERE package_id ILIKE 'ultimate-qualifier%' OR package_id ILIKE 'rookie-pack%'
  GROUP BY 1, 2 ORDER BY 1, 2
`) as Array<Record<string, unknown>>;
for (const r of byPkg)
  console.log(
    `  ${r.package_id}  loc=${r.location}  bookings=${r.bookings}  people=${r.people}  ${r.first} → ${r.last}`,
  );

console.log("\n══ 3. sales_log — legacy rookie_pack=TRUE rows w/o package_id ══");
const legacy = (await q`
  SELECT location, COUNT(*)::int AS bookings, COALESCE(SUM(participant_count),0)::int AS people,
         MIN(ts)::date AS first, MAX(ts)::date AS last
  FROM sales_log
  WHERE rookie_pack IS TRUE AND package_id IS NULL
  GROUP BY 1 ORDER BY 1
`) as Array<Record<string, unknown>>;
for (const r of legacy)
  console.log(`  loc=${r.location}  bookings=${r.bookings}  people=${r.people}  ${r.first} → ${r.last}`);

console.log(
  "\n══ 4. sales_log — NULL-package rows whose product names look UQ/Rookie-shaped (kiosk candidates) ══",
);
const nullPkg = (await q`
  SELECT ts, location, booking_type, participant_count, race_product_names, express_lane
  FROM sales_log
  WHERE package_id IS NULL
    AND rookie_pack IS NOT TRUE
    AND EXISTS (
      SELECT 1 FROM unnest(COALESCE(race_product_names, ARRAY[]::text[])) x
      WHERE x ILIKE '%qualif%' OR x ILIKE '%rookie%' OR x ILIKE '%intermediate%'
    )
  ORDER BY ts DESC
  LIMIT 40
`) as Array<Record<string, unknown>>;
console.log(`  ${nullPkg.length} rows (showing up to 40):`);
for (const r of nullPkg)
  console.log(
    `  ${String(r.ts).slice(0, 10)}  loc=${r.location}  type=${r.booking_type}  n=${r.participant_count}  express=${r.express_lane}  names=${JSON.stringify(r.race_product_names)}`,
  );

console.log("\n══ 5. bowling_reservations — VIP combo legs by combo × center × source × kind × status ══");
const combos = (await q`
  SELECT combo_special_id, center_code, COALESCE(booking_source, '(null)') AS src,
         product_kind, status, COUNT(*)::int AS rows,
         COALESCE(SUM(player_count), 0)::int AS players,
         MIN(inserted_at)::date AS first, MAX(inserted_at)::date AS last
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5
  ORDER BY 1, 2, 3, 4, 5
`) as Array<Record<string, unknown>>;
for (const r of combos)
  console.log(
    `  ${r.combo_special_id}  center=${r.center_code}  src=${r.src}  kind=${r.product_kind}  status=${r.status}  rows=${r.rows}  players=${r.players}  ${r.first} → ${r.last}`,
  );

console.log("\n══ 6. VIP combo BOOKINGS (grouped: one booking = one deposit order / solo row) ══");
const comboBookings = (await q`
  WITH legs AS (
    SELECT combo_special_id, center_code, COALESCE(booking_source, 'web') AS src, status,
           player_count, inserted_at,
           COALESCE(square_deposit_order_id, 'row-' || id::text) AS grp
    FROM bowling_reservations
    WHERE combo_special_id IS NOT NULL
  )
  SELECT combo_special_id, src,
         COUNT(DISTINCT grp)::int AS bookings,
         MAX(player_count)::int AS max_players,
         MIN(inserted_at)::date AS first, MAX(inserted_at)::date AS last
  FROM legs
  GROUP BY 1, 2 ORDER BY 1, 2
`) as Array<Record<string, unknown>>;
for (const r of comboBookings)
  console.log(
    `  ${r.combo_special_id}  src=${r.src}  bookings=${r.bookings}  ${r.first} → ${r.last}`,
  );

console.log("\n══ 7. VIP combo bookings detail: per group (booking) player count + status + center(s) ══");
const detail = (await q`
  WITH legs AS (
    SELECT combo_special_id, center_code, COALESCE(booking_source, 'web') AS src, status,
           player_count, inserted_at,
           COALESCE(square_deposit_order_id, 'row-' || id::text) AS grp
    FROM bowling_reservations
    WHERE combo_special_id IS NOT NULL
  ), grouped AS (
    SELECT combo_special_id, grp,
           MAX(src) AS src,
           MAX(player_count) AS players,
           BOOL_OR(status IN ('canceled', 'cancelled', 'refunded')) AS any_canceled,
           STRING_AGG(DISTINCT center_code, '+') AS centers,
           MIN(inserted_at)::date AS day
    FROM legs GROUP BY 1, 2
  )
  SELECT combo_special_id, src, centers, any_canceled,
         COUNT(*)::int AS bookings, COALESCE(SUM(players), 0)::int AS people,
         MIN(day) AS first, MAX(day) AS last
  FROM grouped
  GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
`) as Array<Record<string, unknown>>;
for (const r of detail)
  console.log(
    `  ${r.combo_special_id}  src=${r.src}  centers=${r.centers}  canceled=${r.any_canceled}  bookings=${r.bookings}  people=${r.people}  ${r.first} → ${r.last}`,
  );
