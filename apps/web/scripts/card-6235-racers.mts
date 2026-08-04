/**
 * READ-ONLY close-out for Natalie Torres / ****6235 (2026-07-28).
 *
 * Confirms the replacement deposit GC (WEBFT06502272) was funded by moving the
 * orphaned deposit rather than by a second charge, and pulls the racer names off
 * the day-of orders behind BMI W55673. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-racers.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const d = (c: any) => `$${((c ?? 0) / 100).toFixed(2)}`;
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;
const et = (s: unknown) =>
  s ? new Date(String(s)).toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false }).replace(",", "") : "-";
async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { headers: H, ...init });
  return { ok: res.ok, j: (await res.json().catch(() => ({}))) as any };
}

// Every activity type Square can return, so no amount prints as a false $0.00.
function activityAmount(a: any) {
  const det =
    a.load_activity_details ??
    a.activate_activity_details ??
    a.redeem_activity_details ??
    a.refund_activity_details ??
    a.adjust_decrement_activity_details ??
    a.adjust_increment_activity_details ??
    a.deactivate_activity_details ??
    a.transfer_balance_from_activity_details ??
    a.transfer_balance_to_activity_details ??
    a.clear_balance_activity_details ??
    {};
  return {
    amt: money(a.gift_card_activity_amount_money ?? det.amount_money),
    order: det.order_id ?? "-",
    payment: det.payment_id ?? "-",
    reason: det.reason ?? "-",
  };
}

for (const [label, id] of [
  ["ORPHAN deposit GC  WEBHPFM06501987", "gftc:baad1c1051224b6190c0054dfabcc67d"],
  ["REPLACEMENT GC     WEBFT06502272", "gftc:b8d5cd4725f443acaf4a1b4c82a1cd8d"],
] as const) {
  console.log(`\n══════ ${label} ══════`);
  const { ok: gok, j: gj } = await sq(`/gift-cards/${encodeURIComponent(id)}`);
  if (gok && gj.gift_card)
    console.log(`  state=${gj.gift_card.state} BALANCE=${d(money(gj.gift_card.balance_money))} created=${et(gj.gift_card.created_at)}`);
  const qs = new URLSearchParams({ gift_card_id: id, limit: "100", sort_order: "ASC" });
  const { ok, j } = await sq(`/gift-cards/activities?${qs}`);
  if (!ok) {
    console.log(`  ${JSON.stringify(j).slice(0, 300)}`);
    continue;
  }
  for (const a of (j.gift_card_activities ?? []) as any[]) {
    const x = activityAmount(a);
    console.log(
      `  ${et(a.created_at)} ET  ${String(a.type).padEnd(22)} ${d(x.amt).padStart(10)}  balance_after=${d(money(a.gift_card_balance_money))}` +
        `\n      order=${x.order} payment=${x.payment} reason=${x.reason} loc=${a.location_id}`,
    );
  }
}

// ── racers: the day-of orders carry the per-racer lines ──
for (const [label, id] of [
  ["RACE day-of order", "NEnxYGhwj9gCdL7TvMjywGIwF9BZY"],
  ["BOWLING day-of order", "tIJFYYc5Ru89bj8YhBUdtpN3kDNZY"],
] as const) {
  console.log(`\n══════ ${label} ${id} ══════`);
  const { ok, j } = await sq(`/orders/${id}`);
  const o = j.order;
  if (!ok || !o) {
    console.log(`  ${JSON.stringify(j).slice(0, 300)}`);
    continue;
  }
  console.log(
    `  state=${o.state} total=${d(money(o.total_money))} loc=${o.location_id} created=${et(o.created_at)} ref=${o.reference_id ?? "-"}`,
  );
  for (const l of (o.line_items ?? []) as any[]) {
    console.log(`    • ${l.quantity}× "${l.name}" ${d(money(l.total_money))} note="${l.note ?? ""}"`);
    for (const m of (l.modifiers ?? []) as any[]) console.log(`        + ${m.name}`);
  }
  if (o.metadata) console.log(`    metadata=${JSON.stringify(o.metadata)}`);
  for (const f of (o.fulfillments ?? []) as any[])
    console.log(`    FULFILLMENT ${f.type} ${f.state} ${JSON.stringify(f.pickup_details?.recipient ?? f.delivery_details?.recipient ?? {})}`);
}
process.exit(0);
