/** READ-ONLY probe: Traci Roa's full combo (all sibling rows + lines + metadata). */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

const rows = (await q`
  SELECT * FROM bowling_reservations
  WHERE guest_email = 'traci.roa001@gmail.com' AND combo_special_id = 'race-bowl-v2'
  ORDER BY id
`) as Array<Record<string, unknown>>;

for (const r of rows) {
  console.log(`\n===== #${r.id} kind=${r.product_kind} status=${r.status} =====`);
  for (const [k, v] of Object.entries(r)) {
    if (v === null || k === "booking_metadata" || k === "attraction_bookings") continue;
    console.log(`  ${k}: ${String(v).slice(0, 120)}`);
  }
  console.log("  booking_metadata:", JSON.stringify(r.booking_metadata, null, 1)?.slice(0, 3000));
  if (r.attraction_bookings) {
    console.log("  attraction_bookings:", JSON.stringify(r.attraction_bookings, null, 1)?.slice(0, 1500));
  }
  const lines = (await q`SELECT * FROM bowling_reservation_lines WHERE reservation_id = ${r.id} ORDER BY id`) as Array<Record<string, unknown>>;
  for (const l of lines) {
    console.log(`  line: ${JSON.stringify(l).slice(0, 300)}`);
  }
}
