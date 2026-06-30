/** READ-ONLY: for combo (VIP) bowling-reservation legs whose slot is in the PAST,
 * report whether the day-of Square order closed (COMPLETED) or is still OPEN. Mirrors
 * combo-settle-open-legs' selection but makes ZERO writes. */
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
const D = (c: number) => `$${((c || 0) / 100).toFixed(2)}`;
const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const rows = (await sql`
  SELECT id, combo_special_id, product_kind, guest_name, status,
         square_dayof_order_id AS oid, square_gift_card_id AS gc,
         to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS ymd
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
    AND square_dayof_order_id IS NOT NULL
    AND booked_at < NOW() - INTERVAL '2 hours'
  ORDER BY booked_at, id
`) as any[];

console.log(`Past combo legs with a day-of order (today ET ${todayET}): ${rows.length}\n`);
const byState: Record<string, number> = {};
const open: string[] = [];
let openDueCents = 0;
for (const r of rows) {
  const oid = String(r.oid);
  const o = (await (await fetch(`${BASE}/orders/${oid}`, { headers: H })).json().catch(() => ({}))).order;
  if (!o) {
    byState["FETCH_FAIL"] = (byState["FETCH_FAIL"] ?? 0) + 1;
    continue;
  }
  byState[o.state] = (byState[o.state] ?? 0) + 1;
  if (o.state === "OPEN") {
    const due = o.net_amount_due_money?.amount ?? o.total_money?.amount ?? 0;
    openDueCents += due;
    // gift card balance to see if it COULD settle
    let bal = -1;
    if (r.gc) {
      const g = (await (await fetch(`${BASE}/gift-cards/${String(r.gc)}`, { headers: H })).json().catch(() => ({}))).gift_card;
      bal = g?.balance_money?.amount ?? -1;
    }
    open.push(
      `  OPEN  ${r.ymd}  res#${r.id} combo${r.combo_special_id} ${String(r.product_kind).padEnd(5)} ${String(r.guest_name).slice(0, 18).padEnd(18)} due ${D(due)}  gcBal=${bal < 0 ? "?" : D(bal)}${bal >= 0 && bal >= due ? " (covers ⇒ settle-able)" : bal >= 0 ? " (short)" : ""}  status=${r.status}  ${oid.slice(0, 8)}`,
    );
  }
}
console.log("Combo-leg day-of order states (past):");
for (const [s, n] of Object.entries(byState).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);
if (open.length) {
  console.log(`\n=== ${open.length} past combo legs still OPEN (${D(openDueCents)} due) ===`);
  for (const l of open.sort()) console.log(l);
} else {
  console.log(`\n✅ All past combo-leg day-of orders are closed.`);
}
process.exit(0);
