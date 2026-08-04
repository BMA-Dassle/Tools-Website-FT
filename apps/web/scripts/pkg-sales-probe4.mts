/** READ-ONLY probe #4: pov/license/rookie labels + web pkg monthly. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

console.log("== pov/license/rookie/qualifier line labels on race rows ==");
const l = await q`
  SELECT COALESCE(r.booking_source,'web') AS src, l.label, COUNT(*)::int AS n
  FROM bowling_reservation_lines l JOIN bowling_reservations r ON r.id = l.reservation_id
  WHERE r.product_kind = 'race'
    AND (l.label ILIKE '%pov%' OR l.label ILIKE '%license%' OR l.label ILIKE '%rookie%' OR l.label ILIKE '%qualif%')
  GROUP BY 1,2 ORDER BY n DESC LIMIT 20`;
console.log(JSON.stringify(l));

console.log("== sales_log UQ/rookie monthly (web) ==");
const m2 = await q`
  SELECT to_char(date_trunc('month', ts AT TIME ZONE 'America/New_York'), 'YYYY-MM') AS month,
         CASE WHEN package_id ILIKE 'ultimate-qualifier%' THEN 'UQ' ELSE 'Rookie' END AS fam,
         COUNT(*)::int AS bookings, COALESCE(SUM(participant_count),0)::int AS people
  FROM sales_log
  WHERE package_id ILIKE 'ultimate-qualifier%' OR package_id ILIKE 'rookie-pack%'
  GROUP BY 1,2 ORDER BY 1,2`;
for (const r of m2 as Array<Record<string, unknown>>) console.log(`  ${r.month}  ${r.fam}  bookings=${r.bookings} people=${r.people}`);
