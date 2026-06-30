/** VIP hourly bowling price from Neon (authoritative for what the combo books).
 *  vip-mon-thur (#6) + vip-fri-sun (#10) are the hourly VIP experiences. Read-only. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

console.log("=== experience items for VIP hourly (#6 vip-mon-thur, #10 vip-fri-sun) ===");
const items = (await q`
  SELECT * FROM bowling_experience_items WHERE experience_id IN (6, 10) ORDER BY experience_id, sort_order
`) as Array<Record<string, unknown>>;
for (const i of items) console.log(JSON.stringify(i));

console.log("\n=== duration options for #6/#10 ===");
const opts = (await q`
  SELECT * FROM bowling_experience_duration_options WHERE experience_id IN (6, 10) ORDER BY experience_id, duration_minutes
`) as Array<Record<string, unknown>>;
for (const o of opts) console.log(JSON.stringify(o));

console.log("\n=== square products referenced ===");
const prods = (await q`
  SELECT id, label, price_cents, deposit_pct FROM bowling_square_products
  WHERE id IN (SELECT square_product_id FROM bowling_experience_items WHERE experience_id IN (6,10))
  ORDER BY id
`) as Array<Record<string, unknown>>;
for (const p of prods)
  console.log(`  #${p.id} ${p.label}: $${(Number(p.price_cents) / 100).toFixed(2)} dep ${p.deposit_pct}%`);
