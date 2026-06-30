/**
 * READ-ONLY planner for the BOWLING (open) legs of VIP combos.
 * Classifies every bowling-leg day-of order into an action bucket:
 *   DONE            — Square order already COMPLETED, nothing to do
 *   COMPLETE-ONLY   — paid (tender, $0 due) but state OPEN → just flip → COMPLETED
 *   CHARGE+COMPLETE — OPEN with balance due, gift card covers, event passed → charge then complete
 *   SKIP-FUTURE     — OPEN with due, event not yet passed
 *   SKIP-CANCELLED  — reservation cancelled
 *   SKIP-NOFUNDS    — OPEN with due but gift card cannot cover
 * Pass --live to combo-bowling-complete-run; this script NEVER writes.
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {}
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const D = (c?: number) => `$${(((c ?? 0)) / 100).toFixed(2)}`;
const { sql } = await import("@/lib/db");
const q = sql();
const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const rows = (await q`
  SELECT id, product_kind, guest_name, status,
         square_dayof_order_id AS oid, square_gift_card_id AS gc,
         to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD HH24:MI') AS ymd
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
    AND product_kind = 'open'
    AND square_dayof_order_id IS NOT NULL
  ORDER BY booked_at, id
`) as Array<Record<string, any>>;

const buckets: Record<string, any[]> = {};
const push = (b: string, line: any) => ((buckets[b] ??= []).push(line));

for (const r of rows) {
  const oid = String(r.oid);
  const ymd = String(r.ymd).slice(0, 10);
  const o = (await (await fetch(`${BASE}/orders/${oid}`, { headers: H })).json().catch(() => ({}))).order;
  const who = String(r.guest_name).slice(0, 18).padEnd(18);
  const tag = `${ymd} res#${r.id} ${who}`;
  if (!o) { push("FETCH_FAIL", { r, oid, line: `${tag} ${oid.slice(0, 8)}` }); continue; }
  const due = o.net_amount_due_money?.amount ?? o.total_money?.amount ?? 0;
  const tenders = o.tenders?.length ?? 0;
  const ver = o.version;
  const past = ymd <= todayET;
  const base = { r, oid, locationId: o.location_id, due, ver, gc: r.gc ? String(r.gc) : null };

  if (o.state === "COMPLETED") { push("DONE", { ...base, line: `${tag} total ${D(o.total_money?.amount)}` }); continue; }
  if (String(r.status) === "cancelled" || o.state === "CANCELED") { push("SKIP-CANCELLED", { ...base, line: `${tag} due ${D(due)}` }); continue; }

  if (due <= 0) {
    // paid (or $0) + OPEN → just complete
    push("COMPLETE-ONLY", { ...base, action: "complete", line: `${tag} total ${D(o.total_money?.amount)} tenders=${tenders}` });
    continue;
  }
  // balance due
  if (!past) { push("SKIP-FUTURE", { ...base, line: `${tag} due ${D(due)} (event ${ymd})` }); continue; }
  let bal = -1;
  if (r.gc) bal = (await (await fetch(`${BASE}/gift-cards/${String(r.gc)}`, { headers: H })).json().catch(() => ({}))).gift_card?.balance_money?.amount ?? -1;
  if (bal < due) { push("SKIP-NOFUNDS", { ...base, line: `${tag} due ${D(due)} gcBal ${bal < 0 ? "?" : D(bal)}` }); continue; }
  push("CHARGE+COMPLETE", { ...base, action: "charge", gcBal: bal, line: `${tag} due ${D(due)} gcBal ${D(bal)}` });
}

let chargeTotal = 0, chargeN = 0, completeN = 0;
for (const b of ["DONE", "COMPLETE-ONLY", "CHARGE+COMPLETE", "SKIP-FUTURE", "SKIP-CANCELLED", "SKIP-NOFUNDS", "FETCH_FAIL"]) {
  const list = buckets[b] ?? [];
  if (!list.length) continue;
  console.log(`\n=== ${b} (${list.length}) ===`);
  for (const x of list) {
    console.log(`  ${x.line}`);
    if (b === "CHARGE+COMPLETE") { chargeTotal += x.due; chargeN++; }
    if (b === "COMPLETE-ONLY") completeN++;
  }
}
console.log(`\nSUMMARY: ${completeN} to complete-only, ${chargeN} to charge (${D(chargeTotal)}) then complete.`);

// Emit a machine-readable plan for the run script to consume.
const plan = [
  ...(buckets["COMPLETE-ONLY"] ?? []).map((x) => ({ id: x.r.id, oid: x.oid, locationId: x.locationId, ver: x.ver, action: "complete", due: 0, gc: x.gc })),
  ...(buckets["CHARGE+COMPLETE"] ?? []).map((x) => ({ id: x.r.id, oid: x.oid, locationId: x.locationId, ver: x.ver, action: "charge", due: x.due, gc: x.gc })),
];
const { writeFileSync } = await import("node:fs");
writeFileSync("scripts/.combo-bowling-plan.json", JSON.stringify(plan, null, 2));
console.log(`\nWrote ${plan.length}-item plan → scripts/.combo-bowling-plan.json`);
process.exit(0);
