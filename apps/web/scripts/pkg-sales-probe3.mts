/**
 * READ-ONLY probe #3:
 *  A. distinct line labels on race reservations (per source) — can lines
 *     identify Rookie Pack / license / POV on kiosk bookings?
 *  B. exact UQ classification via package-ONLY Intermediate SKUs
 *     (packages.ts: 45810775/45810802/45811366/45811531/45811390/45811415/45811475)
 *     by source × center × month + racer counts.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

console.log("══ A. line labels on race rows, by source (top 40) ══");
const labels = (await q`
  SELECT COALESCE(r.booking_source, 'web') AS src, l.label, COUNT(*)::int AS n
  FROM bowling_reservation_lines l
  JOIN bowling_reservations r ON r.id = l.reservation_id
  WHERE r.product_kind = 'race'
  GROUP BY 1, 2
  ORDER BY n DESC
  LIMIT 40
`) as Array<Record<string, unknown>>;
for (const r of labels) console.log(`  src=${r.src}  n=${r.n}  label=${JSON.stringify(r.label)}`);

console.log("\n══ B. UQ bookings via package-only Intermediate SKUs ══");
const uq = (await q`
  WITH uq_rows AS (
    SELECT r.id, COALESCE(r.booking_source, 'web') AS src, r.center_code, r.status,
           r.inserted_at,
           (SELECT COUNT(DISTINCT h->>'racer')
            FROM jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
            WHERE h->>'productId' IN ('45810775','45810802','45811366','45811531','45811390','45811415','45811475')
           )::int AS uq_racers
    FROM bowling_reservations r
    WHERE r.product_kind = 'race'
      AND r.booking_metadata IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
        WHERE h->>'productId' IN ('45810775','45810802','45811366','45811531','45811390','45811415','45811475')
      )
  )
  SELECT src, center_code,
         to_char(date_trunc('month', inserted_at AT TIME ZONE 'America/New_York'), 'YYYY-MM') AS month,
         COUNT(*)::int AS bookings,
         SUM(uq_racers)::int AS racers,
         COUNT(*) FILTER (WHERE status IN ('cancelled', 'canceled'))::int AS canceled
  FROM uq_rows
  GROUP BY 1, 2, 3 ORDER BY 3, 1
`) as Array<Record<string, unknown>>;
for (const r of uq)
  console.log(
    `  ${r.month}  src=${r.src}  center=${r.center_code}  bookings=${r.bookings}  racers=${r.racers}  canceled=${r.canceled}`,
  );

console.log("\n══ C. UQ totals by source (all time, race rows) ══");
const uqTot = (await q`
  SELECT COALESCE(r.booking_source, 'web') AS src,
         COUNT(*)::int AS bookings,
         MIN(r.inserted_at)::date AS first, MAX(r.inserted_at)::date AS last
  FROM bowling_reservations r
  WHERE r.product_kind = 'race'
    AND r.booking_metadata IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
      WHERE h->>'productId' IN ('45810775','45810802','45811366','45811531','45811390','45811415','45811475')
    )
  GROUP BY 1 ORDER BY 1
`) as Array<Record<string, unknown>>;
for (const r of uqTot)
  console.log(`  src=${r.src}  bookings=${r.bookings}  ${String(r.first).slice(0, 15)} → ${String(r.last).slice(0, 15)}`);
