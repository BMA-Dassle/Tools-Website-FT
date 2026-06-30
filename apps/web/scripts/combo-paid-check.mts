/** Check actual Square state/tenders for the 3 "paid" combos I skipped. READ-ONLY. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18" };
const { sql } = await import("@/lib/db");
const q = sql();

const rows = (await q`
  SELECT id, product_kind, guest_name, status, square_dayof_order_id AS dayof,
         square_deposit_order_id AS dep, total_cents
  FROM bowling_reservations
  WHERE guest_name IN ('Kathleen Dougherty','Anelson Simon','Juan  Perez','Juan Perez')
    AND combo_special_id IS NOT NULL
  ORDER BY guest_name, product_kind
`) as Array<Record<string, unknown>>;

for (const r of rows) {
  const oid = String(r.dayof);
  const o = (await (await fetch(`https://connect.squareup.com/v2/orders/${oid}`, { headers: H })).json()).order;
  const tenders = o?.tenders?.length ?? 0;
  const lines = (o?.line_items ?? []).map((li: { name?: string }) => li.name).join(" | ");
  console.log(
    `${String(r.guest_name).padEnd(18)} #${r.id} ${String(r.product_kind).padEnd(5)} neonStatus=${String(r.status).padEnd(10)} ` +
      `orderState=${o?.state ?? "?"} tenders=${tenders} net_due=$${((o?.net_amount_due_money?.amount ?? 0) / 100).toFixed(2)} order=${oid.slice(0, 8)}\n    lines: ${lines}`,
  );
}
