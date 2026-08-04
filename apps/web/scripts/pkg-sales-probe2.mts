/**
 * READ-ONLY probe #2: do non-combo RACE bookings get bowling_reservations rows
 * (kind=race) with booking_source? If so, kiosk UQ/Rookie is identifiable there
 * via booking_metadata heats / notes. Also inspect a sample row's metadata.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

console.log("══ A. bowling_reservations: product_kind × combo? × source — full census ══");
const census = (await q`
  SELECT product_kind,
         (combo_special_id IS NOT NULL) AS is_combo,
         COALESCE(booking_source, '(null)') AS src,
         COUNT(*)::int AS rows,
         MIN(inserted_at)::date AS first, MAX(inserted_at)::date AS last
  FROM bowling_reservations
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
`) as Array<Record<string, unknown>>;
for (const r of census)
  console.log(
    `  kind=${r.product_kind}  combo=${r.is_combo}  src=${r.src}  rows=${r.rows}  ${String(r.first).slice(0, 15)} → ${String(r.last).slice(0, 15)}`,
  );

console.log("\n══ B. sample non-combo race rows (if any) — notes + metadata shape ══");
const sample = (await q`
  SELECT id, center_code, booking_source, status, player_count, bmi_bill_id,
         notes, inserted_at, booking_metadata
  FROM bowling_reservations
  WHERE product_kind = 'race' AND combo_special_id IS NULL
  ORDER BY inserted_at DESC
  LIMIT 5
`) as Array<Record<string, unknown>>;
for (const r of sample) {
  const { booking_metadata, ...rest } = r;
  console.log(" ", JSON.stringify(rest));
  console.log("   meta:", JSON.stringify(booking_metadata)?.slice(0, 400));
}

console.log("\n══ C. kiosk-vs-web candidate: sales_log NULL-package rows w/ BOTH starter+intermediate ══");
const uqShaped = (await q`
  SELECT to_char(date_trunc('month', ts AT TIME ZONE 'America/New_York'), 'YYYY-MM') AS month,
         COUNT(*)::int AS bookings, COALESCE(SUM(participant_count), 0)::int AS people
  FROM sales_log
  WHERE package_id IS NULL AND rookie_pack IS NOT TRUE
    AND EXISTS (SELECT 1 FROM unnest(COALESCE(race_product_names, ARRAY[]::text[])) x WHERE x ILIKE '%starter%')
    AND EXISTS (SELECT 1 FROM unnest(COALESCE(race_product_names, ARRAY[]::text[])) x WHERE x ILIKE '%intermediate%')
  GROUP BY 1 ORDER BY 1
`) as Array<Record<string, unknown>>;
for (const r of uqShaped) console.log(`  ${r.month}  bookings=${r.bookings}  people=${r.people}`);
