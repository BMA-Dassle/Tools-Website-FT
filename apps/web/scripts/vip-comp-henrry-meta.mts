/** READ-ONLY: dump booking_metadata + lines for rows 18546/18547. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const rows = (await q`
  SELECT id, product_kind, booking_metadata FROM bowling_reservations WHERE id IN (18546, 18547) ORDER BY id
`) as Array<Record<string, unknown>>;
for (const r of rows) {
  console.log(`\n===== #${r.id} ${r.product_kind} booking_metadata =====`);
  console.log(JSON.stringify(r.booking_metadata, null, 1)?.slice(0, 4000));
}
const lines = (await q`
  SELECT reservation_id, label, quantity, unit_price_cents FROM bowling_reservation_lines
  WHERE reservation_id IN (18546, 18547) ORDER BY reservation_id, id
`) as Array<Record<string, unknown>>;
console.log("\n===== lines =====");
for (const l of lines) console.log(`#${l.reservation_id} ${l.quantity} × ${l.label} @ $${(Number(l.unit_price_cents) / 100).toFixed(2)}`);
