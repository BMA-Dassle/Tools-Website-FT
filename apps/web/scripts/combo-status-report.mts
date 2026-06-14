/** Status of every VIP combo: split into 2 orders or not, tendered, line names. READ-ONLY. */
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
  SELECT id, product_kind, guest_name, square_deposit_order_id AS dep,
         square_dayof_order_id AS dayof, total_cents, booked_at
  FROM bowling_reservations WHERE combo_special_id IS NOT NULL
  ORDER BY booked_at, id
`) as Array<Record<string, unknown>>;

const byDep = new Map<string, Array<Record<string, unknown>>>();
for (const r of rows) {
  const k = String(r.dep ?? `none-${r.id}`);
  if (!byDep.has(k)) byDep.set(k, []);
  byDep.get(k)!.push(r);
}

const orderCache = new Map<string, { state: string; tenders: number; names: string[] }>();
async function getOrder(id: string) {
  if (orderCache.has(id)) return orderCache.get(id)!;
  const o = (await (await fetch(`https://connect.squareup.com/v2/orders/${id}`, { headers: H })).json()).order;
  const info = { state: o?.state ?? "?", tenders: o?.tenders?.length ?? 0, names: (o?.line_items ?? []).map((li: { name?: string }) => li.name ?? "?") };
  orderCache.set(id, info);
  return info;
}

console.log(`${byDep.size} VIP combos:\n`);
for (const [dep, legs] of byDep) {
  const distinctOrders = [...new Set(legs.map((l) => String(l.dayof)).filter((x) => x && x !== "null"))];
  const split = distinctOrders.length >= 2;
  let tendered = 0;
  let prefixed = true;
  let anyComboLine = false;
  for (const oid of distinctOrders) {
    const o = await getOrder(oid);
    tendered += o.tenders;
    for (const n of o.names) {
      if (/Starter Race|Intermediate Race|VIP Bowling|POV|Shoes|Ultimate Qualifier|License|Booking Fee/i.test(n)) {
        anyComboLine = true;
        if (!/^VIP Exp -/i.test(n)) prefixed = false;
      }
    }
  }
  const who = String(legs[0].guest_name ?? "").slice(0, 18).padEnd(18);
  console.log(
    `${who} ${split ? "SPLIT (2)" : "single  "} ${tendered > 0 ? "tendered" : "open    "} ${anyComboLine ? (prefixed ? "VIPExp✓" : "NObrand") : "?"}  dep=${dep.slice(0, 8)} orders=[${distinctOrders.map((o) => o.slice(0, 6)).join(",")}]`,
  );
}
