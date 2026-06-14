/**
 * Rebrand existing combo day-of order line items with the "VIP Exp - " prefix
 * (keeps each product's catalog id + price). Only OPEN orders can be edited;
 * COMPLETED/tendered orders are reported as skipped (would need refund+resplit).
 *
 * Iterates every combo (combo_special_id) day-of order, renames any unprefixed
 * combo line on OPEN orders, and verifies the order total is unchanged.
 * DRY RUN by default; --live to apply.
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

const COMBO_LINE = /Starter Race|Intermediate Race|POV|FastTrax License|VIP Bowling|Shoes|Booking Fee|Ultimate Qualifier/i;
const prefix = (n: string) => (/^VIP Exp -/i.test(n) ? n : `VIP Exp - ${n}`);

const rows = (await q`
  SELECT DISTINCT square_dayof_order_id AS oid, square_deposit_order_id AS dep, guest_name
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL AND square_dayof_order_id IS NOT NULL
`) as Array<{ oid: string; dep: string; guest_name: string }>;

console.log(LIVE ? "=== LIVE rebrand ===\n" : "=== DRY RUN — pass --live ===\n");

// Group by combo (deposit) and only rebrand combos whose ALL day-of orders are
// OPEN — never half-brand a combo whose other leg is already completed/locked.
const byDep = new Map<string, typeof rows>();
for (const r of rows) {
  const k = String(r.dep ?? r.oid);
  if (!byDep.has(k)) byDep.set(k, []);
  byDep.get(k)!.push(r);
}
const eligible = new Set<string>();
for (const [, legs] of byDep) {
  const states = await Promise.all(
    legs.map(async (l) => (await (await fetch(`${SQB}/orders/${l.oid}`, { headers: H })).json()).order?.state),
  );
  if (states.every((s) => s === "OPEN")) for (const l of legs) eligible.add(l.oid);
  else
    console.log(
      `SKIP combo ${String(legs[0].guest_name).slice(0, 16)} — not all legs OPEN (${states.join("/")}); rebrand needs refund+resplit`,
    );
}

for (const { oid, guest_name } of rows.filter((r) => eligible.has(r.oid))) {
  const o = (await (await fetch(`${SQB}/orders/${oid}`, { headers: H })).json()).order;
  if (!o) continue;
  const items = (o.line_items ?? []) as Array<{
    uid?: string;
    name?: string;
    quantity?: string;
    catalog_object_id?: string;
    base_price_money?: { amount?: number; currency?: string };
  }>;
  const needs = items.some((li) => COMBO_LINE.test(li.name ?? "") && !/^VIP Exp -/i.test(li.name ?? ""));
  if (!needs) {
    continue; // already branded or no combo lines
  }
  const label = `${String(guest_name).slice(0, 16).padEnd(16)} ${oid.slice(0, 8)} ${o.state}`;
  if (o.state !== "OPEN") {
    console.log(`SKIP  ${label} — not OPEN (would need refund+resplit): [${items.map((i) => i.name).join(", ")}]`);
    continue;
  }
  const newItems = items.map((li) => ({
    uid: li.uid,
    name: prefix(li.name ?? ""),
    quantity: li.quantity,
    ...(li.catalog_object_id ? { catalog_object_id: li.catalog_object_id } : {}),
    ...(li.base_price_money ? { base_price_money: li.base_price_money } : {}),
  }));
  console.log(`RENAME ${label}: ${items.map((i) => i.name).join(", ")}  →  VIP Exp - …`);
  if (!LIVE) continue;

  const beforeTotal = o.total_money?.amount ?? 0;
  const res = await fetch(`${SQB}/orders/${oid}`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ idempotency_key: `rebrand-${oid.slice(-12)}`, order: { version: o.version, line_items: newItems } }),
  });
  const d = await res.json();
  if (!res.ok || d.errors) {
    console.log(`  ‼ FAILED: ${JSON.stringify(d.errors ?? d)}`);
    continue;
  }
  const afterTotal = d.order?.total_money?.amount ?? -1;
  console.log(`  ${afterTotal === beforeTotal ? "OK" : `‼ TOTAL CHANGED ${beforeTotal}→${afterTotal}`} (now: ${(d.order?.line_items ?? []).map((i: { name?: string }) => i.name).join(", ")})`);
}
console.log(LIVE ? "\n=== DONE ===" : "\n=== DRY RUN COMPLETE ===");
