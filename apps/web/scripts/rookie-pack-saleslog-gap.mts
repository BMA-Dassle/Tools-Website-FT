/**
 * READ-ONLY: what does sales_log actually record for racing sales since the
 * kiosk auto-enroll shipped (2026-07-19)? Square shows 292 orders with a
 * "Rookie Pack" line; if sales_log shows none, the reporting rail is the gap.
 *
 *   node --env-file=apps/web/.env.local apps/web/scripts/rookie-pack-saleslog-gap.mts
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* next */
  }
}
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const SINCE = "2026-07-19";

console.log("── racing sales since", SINCE, "grouped by recorded package_id ──");
console.table(
  await sql`
    SELECT COALESCE(package_id, '(null)') AS package_id,
           COUNT(*)::int AS rows,
           COUNT(*) FILTER (WHERE rookie_pack IS TRUE)::int AS rookie_pack_true,
           COUNT(*) FILTER (WHERE pov_qty > 0)::int AS pov_qty_gt0,
           COUNT(*) FILTER (WHERE license_purchased IS TRUE)::int AS license_true,
           COUNT(*) FILTER (WHERE total_usd IS NULL)::int AS total_usd_null
      FROM sales_log
     WHERE ts >= ${SINCE} AND booking_type = 'racing'
     GROUP BY package_id
     ORDER BY rows DESC
  `,
);

console.log("\n── field coverage across ALL racing rows since", SINCE, "──");
console.table(
  await sql`
    SELECT COUNT(*)::int AS racing_rows,
           COUNT(*) FILTER (WHERE is_new_racer IS TRUE)::int AS new_racer_true,
           COUNT(*) FILTER (WHERE rookie_pack IS NULL)::int AS rookie_pack_null,
           COUNT(*) FILTER (WHERE pov_qty IS NULL)::int AS pov_qty_null,
           COUNT(*) FILTER (WHERE license_purchased IS NULL)::int AS license_null,
           COUNT(*) FILTER (WHERE package_id IS NULL)::int AS package_id_null,
           COUNT(*) FILTER (WHERE total_usd IS NULL)::int AS total_usd_null,
           COUNT(*) FILTER (WHERE reservation_number IS NULL)::int AS resno_null
      FROM sales_log
     WHERE ts >= ${SINCE} AND booking_type = 'racing'
  `,
);

// Same question for the 30 days BEFORE the kiosk shipped its own notify path,
// to show whether this is a new gap or an old one.
console.log("\n── same coverage, 2026-06-19 .. 2026-07-19 (before) ──");
console.table(
  await sql`
    SELECT COUNT(*)::int AS racing_rows,
           COUNT(*) FILTER (WHERE rookie_pack IS TRUE)::int AS rookie_pack_true,
           COUNT(*) FILTER (WHERE package_id IS NOT NULL)::int AS package_id_set,
           COUNT(*) FILTER (WHERE total_usd IS NOT NULL)::int AS total_usd_set
      FROM sales_log
     WHERE ts >= '2026-06-19' AND ts < ${SINCE} AND booking_type = 'racing'
  `,
);
