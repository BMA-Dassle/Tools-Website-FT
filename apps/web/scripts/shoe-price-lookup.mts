/** Normal shoe-rental price from Neon for the combo revenue split. Read-only. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const rows = (await q`
  SELECT id, center_code, product_kind, label, price_cents, square_catalog_object_id
  FROM bowling_square_products
  WHERE product_kind = 'addon_shoe' OR label ILIKE '%shoe%'
  ORDER BY center_code, id
`) as Array<Record<string, unknown>>;
for (const r of rows)
  console.log(
    `#${r.id} ${r.center_code} ${r.product_kind} | ${r.label}: $${(Number(r.price_cents) / 100).toFixed(2)}  cat=${r.square_catalog_object_id}`,
  );
