/** READ-ONLY probe #5: kiosk race-row productId census — are packages.ts
 *  starter SKUs disjoint from kiosk-native plain-race SKUs? If yes, kiosk
 *  Rookie = kiosk rows on package starter SKUs w/o UQ intermediate SKUs. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

console.log("== distinct heat productIds on KIOSK race rows ==");
const ids = await q`
  SELECT h->>'productId' AS pid, h->>'tier' AS tier, COUNT(*)::int AS heats,
         COUNT(DISTINCT r.id)::int AS bookings
  FROM bowling_reservations r,
       jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
  WHERE r.product_kind = 'race' AND r.booking_source = 'kiosk'
  GROUP BY 1,2 ORDER BY heats DESC`;
for (const r of ids as Array<Record<string, unknown>>)
  console.log(`  pid=${r.pid}  tier=${r.tier}  heats=${r.heats}  bookings=${r.bookings}`);

console.log("\n== kiosk ROOKIE candidates: package starter SKUs, no UQ intermediate ==");
const rk = await q`
  WITH rows AS (
    SELECT r.id, r.status, r.inserted_at,
      EXISTS (SELECT 1 FROM jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
              WHERE h->>'productId' IN ('24965505','24960859','24960393','24952964','24953280','24960106','24953399')) AS pkg_starter,
      EXISTS (SELECT 1 FROM jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
              WHERE h->>'productId' IN ('45810775','45810802','45811366','45811531','45811390','45811415','45811475')) AS uq_int,
      (SELECT COUNT(DISTINCT h->>'racer') FROM jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
       WHERE h->>'productId' IN ('24965505','24960859','24960393','24952964','24953280','24960106','24953399'))::int AS starter_racers
    FROM bowling_reservations r
    WHERE r.product_kind = 'race' AND r.booking_source = 'kiosk' AND r.booking_metadata IS NOT NULL
  )
  SELECT to_char(date_trunc('month', inserted_at AT TIME ZONE 'America/New_York'), 'YYYY-MM') AS month,
         COUNT(*) FILTER (WHERE pkg_starter AND NOT uq_int)::int AS rookie_bookings,
         SUM(starter_racers) FILTER (WHERE pkg_starter AND NOT uq_int)::int AS rookie_racers,
         COUNT(*) FILTER (WHERE pkg_starter AND uq_int)::int AS uq_with_pkg_starter
  FROM rows GROUP BY 1 ORDER BY 1`;
for (const r of rk as Array<Record<string, unknown>>)
  console.log(`  ${r.month}  rookie_bookings=${r.rookie_bookings}  rookie_racers=${r.rookie_racers}  (uq rows also on pkg starters: ${r.uq_with_pkg_starter})`);

console.log("\n== same census for WEB race rows (do plain web races share pkg SKUs?) ==");
const web = await q`
  SELECT h->>'productId' AS pid, h->>'tier' AS tier, COUNT(DISTINCT r.id)::int AS bookings
  FROM bowling_reservations r,
       jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
  WHERE r.product_kind = 'race' AND COALESCE(r.booking_source,'web') = 'web'
    AND h->>'productId' IN ('24965505','24960859','24960393','24952964','24953280','24960106','24953399')
  GROUP BY 1,2 ORDER BY bookings DESC LIMIT 10`;
console.log(JSON.stringify(web));
