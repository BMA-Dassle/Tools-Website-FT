/** Inspect Anelson (9u6Q) state after the failed remediation. READ-ONLY. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Square-Version": "2024-12-18" };
const { sql } = await import("@/lib/db");
const q = sql();

const OLD = "9u6QxALDQenCoqQmg4ywXOhmXacZY";
const GC = "gftc:d49e7"; // partial — need full id from Neon

const rows = (await q`
  SELECT id, product_kind, square_dayof_order_id AS dayof, square_gift_card_id AS gc, square_gift_card_gan AS gan
  FROM bowling_reservations WHERE square_dayof_order_id = ${OLD}
`) as Array<Record<string, unknown>>;
console.log("Neon rows still pointing at old order:", rows.map((r) => `#${r.id}(${r.product_kind})`).join(", "));
const gcId = String(rows[0]?.gc ?? "");

const o = (await (await fetch(`https://connect.squareup.com/v2/orders/${OLD}`, { headers: H })).json()).order;
console.log(`\nOLD ${OLD.slice(0, 8)}: state=${o?.state} total=$${((o?.total_money?.amount ?? 0) / 100).toFixed(2)} net_due=$${((o?.net_amount_due_money?.amount ?? 0) / 100).toFixed(2)}`);
console.log(`  tenders: ${(o?.tenders ?? []).map((t: { id?: string; amount_money?: { amount?: number } }) => `${t.id?.slice(0, 8)} $${((t.amount_money?.amount ?? 0) / 100).toFixed(2)}`).join(", ") || "none"}`);
console.log(`  refunds: ${(o?.refunds ?? []).map((r: { id?: string; status?: string; amount_money?: { amount?: number } }) => `${r.status} $${((r.amount_money?.amount ?? 0) / 100).toFixed(2)}`).join(", ") || "none"}`);

if (gcId) {
  const g = (await (await fetch(`https://connect.squareup.com/v2/gift-cards/${gcId}`, { headers: H })).json()).gift_card;
  console.log(`\nGift card ${gcId}: balance=$${((g?.balance_money?.amount ?? 0) / 100).toFixed(2)} state=${g?.state}`);
}

// Find the orphaned new orders created during the failed run (same idempotency keys → idempotent re-fetch via search by location + recent).
console.log(`\nSearching recent FastTrax + HeadPinz orders for the orphaned split orders...`);
for (const [loc, label] of [["LAB52GY480CJF", "FastTrax"], ["TXBSQN0FEKQ11", "HeadPinz"]] as const) {
  const res = await fetch(`https://connect.squareup.com/v2/orders/search`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ location_ids: [loc], query: { filter: { state_filter: { states: ["OPEN"] } }, sort: { sort_field: "CREATED_AT", sort_order: "DESC" } }, limit: 5 }),
  });
  const d = await res.json();
  for (const ord of d.orders ?? []) {
    const names = (ord.line_items ?? []).map((li: { name?: string }) => li.name).join(", ");
    if (/VIP Exp|Starter|VIP Bowling/i.test(names))
      console.log(`  ${label} ${ord.id.slice(0, 10)} created=${ord.created_at} net_due=$${((ord.net_amount_due_money?.amount ?? 0) / 100).toFixed(2)} [${names}]`);
  }
}
