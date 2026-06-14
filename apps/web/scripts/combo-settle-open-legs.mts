/**
 * Settle OPEN combo day-of orders by charging their (already-funded) gift card
 * and completing the order — for combos whose EVENT has already passed. Combo
 * legs are excluded from bowling-no-show-close, and only settle via QAMF/BMI
 * check-in; a guest who never checked in leaves the leg "Pending" forever. This
 * pays it from the card the deposit already funded (NO fulfillment → no kitchen).
 *
 * Only past-event orders (event date < today ET) are charged, so future combos
 * are never settled early. DRY RUN by default; --live to execute.
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
const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// BOWLING legs only — booked_at is the real slot time for bowling (for races
// it's the booking time, so race-dayof-pay owns race settlement). Past-slot by
// >2h, matching bowling-no-show-close's window so no in-progress session is hit.
const rows = (await q`
  SELECT id, product_kind, guest_name, square_dayof_order_id AS oid, square_gift_card_id AS gc,
         to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS ymd
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL AND square_dayof_order_id IS NOT NULL
    AND product_kind IN ('open', 'kbf')
    AND booked_at < NOW() - INTERVAL '2 hours'
  ORDER BY booked_at, id
`) as Array<Record<string, unknown>>;

console.log(LIVE ? "=== LIVE settle ===\n" : `=== DRY RUN (today ET ${todayET}) — pass --live ===\n`);
for (const r of rows) {
  const oid = String(r.oid);
  const gcId = String(r.gc ?? "");
  const ymd = String(r.ymd ?? "");
  const o = (await (await fetch(`${SQB}/orders/${oid}`, { headers: H })).json()).order;
  if (!o || o.state !== "OPEN") continue;
  const due = o.net_amount_due_money?.amount ?? o.total_money?.amount ?? 0;
  if (due <= 0) continue;
  const past = ymd && ymd <= todayET; // event date today-or-earlier
  const label = `${String(r.guest_name).slice(0, 16).padEnd(16)} #${r.id} ${String(r.product_kind).padEnd(5)} ${oid.slice(0, 8)} due $${(due / 100).toFixed(2)} (${ymd})`;
  if (!past) {
    console.log(`FUTURE ${label} — skip (event not yet passed)`);
    continue;
  }
  if (!gcId) {
    console.log(`NO-GC  ${label} — skip`);
    continue;
  }
  const bal = (await (await fetch(`${SQB}/gift-cards/${gcId}`, { headers: H })).json()).gift_card?.balance_money?.amount ?? 0;
  if (bal < due) {
    console.log(`LOW-GC ${label} — card $${(bal / 100).toFixed(2)} < due, skip`);
    continue;
  }
  console.log(`SETTLE ${label} from card $${(bal / 100).toFixed(2)}`);
  if (!LIVE) continue;
  const pay = await fetch(`${SQB}/payments`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ idempotency_key: `cl-settle-${oid.slice(-14)}`, source_id: gcId, amount_money: { amount: due, currency: "USD" }, order_id: oid, location_id: o.location_id, autocomplete: true, note: "combo leg settle (gift card)" }),
  });
  const d = await pay.json();
  if (!pay.ok || d.errors) {
    console.log(`  ‼ FAILED: ${JSON.stringify(d.errors ?? d)}`);
    continue;
  }
  // Complete the order (no fulfillment → no kitchen) and mark the row arrived.
  try {
    const fresh = (await (await fetch(`${SQB}/orders/${oid}`, { headers: H })).json()).order;
    if (fresh?.state !== "COMPLETED" && fresh?.version)
      await fetch(`${SQB}/orders/${oid}`, { method: "PUT", headers: H, body: JSON.stringify({ order: { location_id: o.location_id, version: fresh.version, state: "COMPLETED" } }) });
  } catch {
    /* payment captured; non-fatal */
  }
  // Flip the Neon row to a terminal status so it drops off "Active Only".
  await q`UPDATE bowling_reservations SET status = 'completed' WHERE id = ${r.id}`;
  console.log(`  OK paid $${(due / 100).toFixed(2)} (pay ${String(d.payment?.id).slice(0, 8)}) + status→completed`);
}
console.log(LIVE ? "\n=== DONE ===" : "\n=== DRY RUN COMPLETE ===");
