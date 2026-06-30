/**
 * READ-ONLY: For Sunday's bowling reservations (open + kbf), report the state
 * of each day-of Square order (OPEN / COMPLETED / CANCELED). Answers "are the
 * orders marked complete?" — redeeming the deposit GC != closing the order.
 *   node --env-file=apps/web/.env.local apps/web/scripts/sunday-bowling-order-states.mts 2026-06-14
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
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const DAY = process.argv[2] ?? "2026-06-14";

const rows = (await sql`
  SELECT id, product_kind, status, square_dayof_order_id, deposit_cents, total_cents, guest_name
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date = ${DAY}::date
    AND product_kind IN ('open','kbf') AND combo_special_id IS NULL
    AND square_gift_card_id IS NOT NULL AND square_gift_card_id <> ''
  ORDER BY id
`) as any[];

async function orderState(id: string) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  const data = await res.json().catch(() => ({}));
  const o = data.order;
  return o ? { state: o.state as string, total: o.total_money?.amount ?? 0, paid: o.net_amount_due_money?.amount ?? null } : null;
}

const D = (c: number) => `$${(c / 100).toFixed(2)}`;
const byState: Record<string, number> = {};
const byResStatus: Record<string, number> = {};
let noOrder = 0;
const notComplete: string[] = [];

for (const r of rows) {
  byResStatus[r.status] = (byResStatus[r.status] ?? 0) + 1;
  let orderId: string | undefined = r.square_dayof_order_id;
  try {
    const p = JSON.parse(r.square_dayof_order_id);
    if (Array.isArray(p) && p.length) orderId = p[0];
  } catch {
    /* bare id */
  }
  if (!orderId) {
    noOrder++;
    notComplete.push(`res#${r.id} ${r.guest_name} — NO day-of order (res status=${r.status})`);
    continue;
  }
  const os = await orderState(orderId);
  if (!os) {
    notComplete.push(`res#${r.id} ${r.guest_name} — order ${orderId} fetch failed`);
    continue;
  }
  byState[os.state] = (byState[os.state] ?? 0) + 1;
  if (os.state !== "COMPLETED") {
    notComplete.push(
      `res#${r.id} ${r.guest_name} — order ${os.state} total=${D(os.total)} (res status=${r.status})`,
    );
  }
}

console.log(`Sunday ${DAY} bowling (open+kbf) reservations with a deposit: ${rows.length}\n`);
console.log("Day-of Square order state:");
for (const [s, n] of Object.entries(byState).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);
if (noOrder) console.log(`  (no day-of order): ${noOrder}`);
console.log("\nReservation status (Neon):");
for (const [s, n] of Object.entries(byResStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);
if (notComplete.length) {
  console.log(`\nNot COMPLETED (${notComplete.length}):`);
  for (const l of notComplete) console.log(`  • ${l}`);
} else {
  console.log("\n✅ Every day-of order is COMPLETED.");
}
process.exit(0);
