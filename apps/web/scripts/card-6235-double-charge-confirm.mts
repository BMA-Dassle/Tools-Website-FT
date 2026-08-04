/**
 * READ-ONLY: confirm the ****6235 double charge. Attempt #40 (17:29) captured
 * $346.12 and died at qamf-confirm (invalid email) → orphan. Attempt #51 (18:19)
 * captured $346.12 again and COMPLETED as BMI W55673. Verifies both payments,
 * both bills, and both deposit gift cards. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-double-charge-confirm.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
import { parseWithRawIds } from "@ft/db";
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

const PAYMENTS = [
  ["ORPHAN  (17:29, no reservation)", "rTZTtfIt7nwtUN2Gynlz9AcVXoOZY"],
  ["VOIDED  (17:30, never settled)", "v512IdECN2zcMnlPUZe0JCfeG6EZY"],
  ["GOOD    (18:19, → BMI W55673)", "pEkYfPSbQEilR3pyX8Edu1vYxwLZY"],
];

console.log("══════ PAYMENTS ══════");
for (const [label, id] of PAYMENTS) {
  const { ok, j } = await sq(`/payments/${id}`);
  const p = j.payment;
  if (!ok || !p) {
    console.log(`\n  ${label}  ${id}\n    ${JSON.stringify(j).slice(0, 300)}`);
    continue;
  }
  const c = p.card_details?.card ?? {};
  console.log(
    `\n  ${label}\n    id=${p.id}  ${et(p.created_at)} ET` +
      `\n    ${d(money(p.amount_money))}  status=${p.status}  refunded=${d(money(p.refunded_money))}` +
      `\n    ${c.card_brand} ****${c.last_4} ${c.card_type} exp=${c.exp_month}/${c.exp_year}` +
      `\n    order=${p.order_id}  loc=${p.location_id}  note="${p.note ?? ""}"` +
      `\n    settled=${p.processing_fee?.length ? "YES fee=" + d(money(p.processing_fee[0]?.amount_money)) : "no"}` +
      `\n    REFUNDABLE=${p.status === "COMPLETED" && money(p.refunded_money) === 0 ? "yes, " + d(money(p.amount_money)) : "n/a"}`,
  );
}

// ── both bills in BMI ──
const KEY = "headpinzftmyers";
const SUB = process.env.BMI_SUBSCRIPTION_KEY || "";
const tRes = await fetch(`${process.env.BMI_API_URL || "https://api.bmileisure.com"}/auth/${KEY}/publicbooking`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB },
  body: JSON.stringify({ Username: process.env.BMI_USERNAME, Password: process.env.BMI_PASSWORD }),
});
const tok = (await tRes.json()).AccessToken;

console.log("\n\n══════ BMI BILLS ══════");
for (const [label, bill] of [
  ["ORPHAN bill (17:28)", "63000000006501987"],
  ["abandoned (18:18)", "63000000006502063"],
  ["GOOD bill (18:19)", "63000000006502272"],
] as const) {
  const res = await fetch(
    `${process.env.BMI_API_URL || "https://api.bmileisure.com"}/public-booking/${KEY}/order/${bill}/overview`,
    { headers: { Authorization: `Bearer ${tok}`, "BMI-Subscription-Key": SUB, "Accept-Language": "en" } },
  );
  const text = await res.text();
  console.log(`\n  ── ${label}  ${bill}  HTTP ${res.status} ──`);
  if (!res.ok) {
    console.log(`     ${text.slice(0, 200)}`);
    continue;
  }
  const o = parseWithRawIds(text) as any;
  console.log(
    `     reservation=${o.reservationNumber} conf=${o.confirmationCode} statusId=${o.statusId} date=${o.date}` +
      `\n     contact="${o.contactPerson?.firstName}${o.contactPerson?.lastName}" email="${o.contactPerson?.email}" phone=${o.contactPerson?.phone}` +
      `\n     totalToDeposit=${o.totalToDeposit} totalPaid=${o.totalPaid} lines=${o.lines?.length ?? 0} scheduleDays=${o.scheduleDays?.length ?? 0}`,
  );
  for (const l of o.lines ?? [])
    console.log(`       • ${l.quantity ?? ""}× ${l.description ?? l.name ?? JSON.stringify(l).slice(0, 120)}`);
  for (const sd of o.scheduleDays ?? [])
    console.log(`       ▸ ${JSON.stringify(sd).slice(0, 600)}`);
}

// ── the two deposit gift cards ──
console.log("\n\n══════ DEPOSIT GIFT CARDS ══════");
for (const gan of ["WEBHPFM06501987", "WEBHPFM06502272"]) {
  const { ok, j } = await sq(`/gift-cards/from-gan`, { method: "POST", body: JSON.stringify({ gan }) });
  const g = j.gift_card;
  console.log(
    `  ${gan}: ` +
      (ok && g ? `state=${g.state} BALANCE=${d(money(g.balance_money))} id=${g.id} created=${et(g.created_at)}` : JSON.stringify(j).slice(0, 160)),
  );
}

// ── the good reservation in Neon ──
const sql = neon(process.env.DATABASE_URL!);
console.log("\n\n══════ reserve_attempt #51 (the good one) ══════");
for (const a of (await sql`SELECT * FROM reserve_attempts WHERE id = 51`) as any[])
  console.log(
    `  ${et(a.created_at)} ET state=${a.state} bill=${a.bill_id} bmi=${a.bmi_reservation_number}` +
      `\n  deposit_order=${a.deposit_order_id} deposit_payment=${a.deposit_payment_id}` +
      `\n  neon_ids=${JSON.stringify(a.neon_ids)} qamf=${JSON.stringify(a.qamf_reservation_ids)}` +
      `\n  cart=${JSON.stringify(a.cart)}`,
  );

process.exit(0);
