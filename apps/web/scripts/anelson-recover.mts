/**
 * Recover Anelson (9u6Q) from the failed charged remediation. The refund ALREADY
 * happened (gift card back to $162.93) and both VIP Exp-branded split orders were
 * created but never charged (the payments call failed on a too-long idempotency
 * key). So here we ONLY: charge the two existing orders from the card, repoint the
 * Neon rows, and cancel the old order. NO refund (would double-refund).
 *
 * DRY RUN by default; --live to execute. Short idempotency keys (<=45).
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const LIVE = process.argv.includes("--live");
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const SQB = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Square-Version": "2024-12-18" };
const { sql } = await import("@/lib/db");
const q = sql();

const OLD = "9u6QxALDQenCoqQmg4ywXOhmXacZY";
const GC = "gftc:d49e7e716bdc4904be52fca056626345";
const FT = { id: "73D4MaLuuh4f8mWNn3GIFxqWVxLZY", loc: "LAB52GY480CJF", due: 9370, row: 5494, key: "anelson-ft-pay" };
const HP = { id: "7JqrKMn3ylFY8AdjvfTYV8Gk0SMZY", loc: "TXBSQN0FEKQ11", due: 6922, row: 5493, key: "anelson-hp-pay" };

// Resolve full order ids (the inspect truncated them) — fetch by prefix via search is unreliable,
// so re-fetch the two known orders; if these stubs are wrong, abort.
async function resolveOrder(loc: string, namePat: RegExp) {
  const res = await fetch(`${SQB}/orders/search`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ location_ids: [loc], query: { filter: { state_filter: { states: ["OPEN"] } }, sort: { sort_field: "CREATED_AT", sort_order: "DESC" } }, limit: 5 }),
  });
  const d = await res.json();
  for (const o of d.orders ?? []) {
    const names = (o.line_items ?? []).map((li: { name?: string }) => li.name ?? "").join(",");
    if (namePat.test(names)) return o;
  }
  return null;
}

const ftOrder = await resolveOrder(FT.loc, /VIP Exp - Starter Race/);
const hpOrder = await resolveOrder(HP.loc, /VIP Exp - VIP Bowling/);
if (!ftOrder || !hpOrder) {
  console.log("‼ could not resolve the orphaned orders — abort", { ft: !!ftOrder, hp: !!hpOrder });
  process.exit(1);
}
const ftDue = ftOrder.net_amount_due_money?.amount ?? 0;
const hpDue = hpOrder.net_amount_due_money?.amount ?? 0;
const gc = (await (await fetch(`${SQB}/gift-cards/${GC}`, { headers: H })).json()).gift_card;
const bal = gc?.balance_money?.amount ?? 0;

console.log(`Gift card balance $${(bal / 100).toFixed(2)}`);
console.log(`FastTrax ${ftOrder.id.slice(0, 10)} due $${(ftDue / 100).toFixed(2)} → row #${FT.row}`);
console.log(`HeadPinz ${hpOrder.id.slice(0, 10)} due $${(hpDue / 100).toFixed(2)} → row #${HP.row}`);
console.log(`charge total $${((ftDue + hpDue) / 100).toFixed(2)} vs balance $${(bal / 100).toFixed(2)}`);

if (ftDue + hpDue > bal) {
  console.log("‼ would oversubscribe gift card — abort");
  process.exit(1);
}
if (!LIVE) {
  console.log("\n(dry run) would charge both, repoint #5494→FastTrax / #5493→HeadPinz, cancel old order");
  process.exit(0);
}

async function chargeAndComplete(order: { id: string; location_id: string }, amount: number, key: string) {
  const pay = await fetch(`${SQB}/payments`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ idempotency_key: key, source_id: GC, amount_money: { amount, currency: "USD" }, order_id: order.id, location_id: order.location_id, autocomplete: true, note: "combo split re-charge (recover)" }),
  });
  const d = await pay.json();
  if (!pay.ok || d.errors) throw new Error(`charge ${order.id.slice(0, 8)}: ${JSON.stringify(d.errors ?? d)}`);
  return d.payment?.id as string;
}

const ftPay = await chargeAndComplete(ftOrder, ftDue, FT.key);
const hpPay = await chargeAndComplete(hpOrder, hpDue, HP.key);
console.log(`charged FastTrax (pay ${String(ftPay).slice(0, 8)}) + HeadPinz (pay ${String(hpPay).slice(0, 8)})`);

await q`UPDATE bowling_reservations SET square_dayof_order_id = ${ftOrder.id}, total_cents = ${ftDue}, deposit_cents = ${ftDue} WHERE id = ${FT.row}`;
await q`UPDATE bowling_reservations SET square_dayof_order_id = ${hpOrder.id}, total_cents = ${hpDue}, deposit_cents = ${hpDue} WHERE id = ${HP.row}`;
console.log(`repointed #${FT.row}→FastTrax, #${HP.row}→HeadPinz`);

try {
  const fresh = (await (await fetch(`${SQB}/orders/${OLD}`, { headers: H })).json()).order;
  const c = await fetch(`${SQB}/orders/${OLD}`, { method: "PUT", headers: H, body: JSON.stringify({ idempotency_key: "anelson-cancel-old", order: { version: fresh?.version, state: "CANCELED" } }) });
  console.log(`old order cancel: ${c.ok ? "OK" : `FAILED ${c.status} (orphaned, non-fatal)`}`);
} catch (e) {
  console.log(`old cancel error (non-fatal): ${e instanceof Error ? e.message : e}`);
}
console.log("=== DONE ===");
