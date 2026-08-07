/**
 * READ-ONLY sanity: are the waiver/check-in tables actually empty, or am I
 * pointed at the wrong database? Counts every related table plus a known-good
 * control table. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/waiver-tables-sanity.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const { sql } = await import("@/lib/db");
const q = sql();

const url = process.env.DATABASE_URL || "";
const hostMatch = url.match(/@([^/]+)\//);
console.log(`DB host: ${hostMatch ? hostMatch[1] : "(unparsed)"}`);

const tables = [
  "kiosk_waiver_joins",
  "kiosk_waivers",
  "waiver_acceptances",
  "kiosk_checkin_events",
  "kiosk_checkin_people",
  "bowling_reservations", // control — must be non-zero
];
console.log("\n══════ row counts ══════");
for (const t of tables) {
  try {
    const r = (await q.query(`SELECT count(*)::int AS n FROM ${t}`)) as Array<Record<string, any>>;
    console.log(`  ${t.padEnd(24)} ${String(r[0].n).padStart(8)}`);
  } catch (e) {
    console.log(`  ${t.padEnd(24)} ERROR ${e instanceof Error ? e.message : e}`);
  }
}

console.log("\n══════ bowling_reservations columns (find the timestamp) ══════");
const cols = (await q`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='bowling_reservations'
    AND (column_name LIKE '%_at' OR column_name LIKE '%date%')
  ORDER BY column_name
`) as Array<Record<string, any>>;
console.log("  " + cols.map((c) => c.column_name).join(", "));

console.log("\n══════ RC8 scale: race heats with NULL bmiPersonId (last 90d) ══════");
try {
  const r = (await q`
    SELECT count(DISTINCT r.id)::int AS reservations,
           count(h.e)::int AS total_racers,
           sum(CASE WHEN h.e->>'bmiPersonId' IS NULL THEN 1 ELSE 0 END)::int AS null_racers
    FROM bowling_reservations r,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(r.booking_metadata::jsonb->'heats')='array'
                THEN r.booking_metadata::jsonb->'heats' ELSE '[]'::jsonb END) AS h(e)
    WHERE r.product_kind = 'race' AND r.status = 'confirmed'
      AND r.booked_at > now() - interval '90 days'
  `) as Array<Record<string, any>>;
  const { reservations, total_racers, null_racers } = r[0];
  console.log(
    `  ${reservations} reservations, ${total_racers} racer rows, ${null_racers} with NULL bmiPersonId ` +
      `(${total_racers ? Math.round((null_racers / total_racers) * 100) : 0}%)`,
  );
} catch (e) {
  console.log(`  query failed: ${e instanceof Error ? e.message : e}`);
}
process.exit(0);
