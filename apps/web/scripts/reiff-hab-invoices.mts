/**
 * READ-ONLY: Ryan Reiff's Have-A-Ball subscription — invoice + card + payment detail.
 *
 * The roster hunt (reiff-hab-hunt.mts) found the subscription ACTIVE but with
 * three OPEN orders (7/14, 7/21, 7/28) and a card on the customer that was
 * created TODAY while the subscription still points at the ORIGINAL card token.
 * This script establishes: which invoices are unpaid, why, and whether the
 * subscription's card_id still resolves.
 *
 * Usage: npx tsx scripts/reiff-hab-invoices.mts
 */
import { readFileSync } from "node:fs";

const envRaw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
function envVal(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  const m = envRaw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}
const HEADERS = {
  Authorization: `Bearer ${envVal("SQUARE_ACCESS_TOKEN")}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const BASE = "https://connect.squareup.com/v2";

async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: HEADERS });
  const text = await res.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text };
  }
  if (!res.ok) console.error(`  ! ${res.status} ${path}: ${text.slice(0, 400)}`);
  return j;
}

const CUSTOMER = "NMM1MRB8JF2B036ZAWJY8QCCXR";
const SUB = "4d72fc03-094a-4079-87e7-36f4028deffe";
const SUB_CARD = "ccof:CA4SEBDxZigpDMHF9iMrNSJubZsoAg";
const NEW_CARD = "ccof:CA4SEDqvaUtD-ViO03ZmV3cGKmYoAg";
const LOCATION = "TXBSQN0FEKQ11";
const usd = (c?: number) => `$${((c ?? 0) / 100).toFixed(2)}`;

// ---- 1. Does the subscription's card still exist / is it enabled? ----------
console.log("=".repeat(78));
console.log("1. CARDS — subscription card vs. the card added today");
console.log("=".repeat(78));
for (const [label, id] of [
  ["sub card_id (original)", SUB_CARD],
  ["customer card (created today)", NEW_CARD],
] as const) {
  const d = await sq(`/cards/${encodeURIComponent(id)}`);
  const c = d.card;
  console.log(`\n${label}: ${id}`);
  if (!c) {
    console.log(`   -> NOT RETRIEVABLE: ${JSON.stringify(d.errors ?? d).slice(0, 300)}`);
    continue;
  }
  console.log(
    `   ${c.card_brand} ••${c.last_4}  exp=${c.exp_month}/${c.exp_year}  enabled=${c.enabled}  ` +
      `holder=${c.cardholder_name}  cust=${c.customer_id}  created=${c.created_at}  ` +
      `merchant=${c.merchant_id}  ref=${c.reference_id ?? "-"}`,
  );
}

// ---- 2. Every invoice on the subscription ---------------------------------
console.log("\n" + "=".repeat(78));
console.log("2. INVOICES on the subscription (chronological)");
console.log("=".repeat(78));

const sub = (await sq(`/subscriptions/${SUB}`)).subscription;
const invoiceIds: string[] = sub?.invoice_ids ?? [];
console.log(`${invoiceIds.length} invoice id(s) on the subscription\n`);

const rows: any[] = [];
for (const invId of invoiceIds) {
  const d = await sq(`/invoices/${encodeURIComponent(invId)}`);
  const inv = d.invoice;
  if (!inv) {
    console.log(`   ${invId} -> NOT RETRIEVABLE`);
    continue;
  }
  rows.push(inv);
}
rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

let unpaidTotal = 0;
for (const inv of rows) {
  const req = inv.payment_requests?.[0];
  const paid = inv.payment_requests?.reduce(
    (s: number, r: any) => s + (r.total_completed_amount_money?.amount ?? 0),
    0,
  );
  const due = (inv.payment_requests ?? []).reduce(
    (s: number, r: any) => s + (r.computed_amount_money?.amount ?? 0),
    0,
  );
  if (inv.status !== "PAID") unpaidTotal += due - (paid ?? 0);
  console.log(
    `   #${inv.invoice_number ?? "?"}  ${String(inv.created_at).slice(0, 10)}  ` +
      `status=${inv.status}  due=${usd(due)}  paid=${usd(paid)}  ` +
      `order=${inv.order_id}  card=${req?.card_id ?? "-"}  ` +
      `auto=${req?.automatic_payment_source ?? "-"}  ${inv.id}`,
  );
  if (inv.status !== "PAID") {
    console.log(`      FULL: ${JSON.stringify(inv)}`);
  }
}
console.log(`\nTOTAL OUTSTANDING on this subscription: ${usd(unpaidTotal)}`);

// ---- 3. Payments for this customer (successes AND failures) ---------------
console.log("\n" + "=".repeat(78));
console.log("3. PAYMENTS for the customer (all statuses, 2026-05-01 onward)");
console.log("=".repeat(78));

// Targeted: pull the tenders/payments off THIS customer's orders rather than
// sweeping every payment at the location (tens of thousands at FM).
const orderSearch = await sq("/orders/search", {
  method: "POST",
  body: JSON.stringify({
    location_ids: [LOCATION],
    query: { filter: { customer_filter: { customer_ids: [CUSTOMER] } } },
    limit: 100,
  }),
});
const payments: any[] = [];
for (const o of orderSearch.orders ?? []) {
  for (const t of o.tenders ?? []) {
    if (!t.payment_id) continue;
    const d = await sq(`/payments/${t.payment_id}`);
    if (d.payment) payments.push(d.payment);
  }
}

console.log(`${payments.length} payment(s) across this customer's orders`);
payments.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
for (const p of payments) {
  console.log(
    `   ${String(p.created_at).slice(0, 19)}  ${p.status.padEnd(9)}  ${usd(p.amount_money?.amount)}  ` +
      `${p.card_details?.card?.card_brand ?? "?"} ••${p.card_details?.card?.last_4 ?? "????"}  ` +
      `entry=${p.card_details?.entry_method ?? "-"}  ` +
      `err=${p.card_details?.errors?.map((e: any) => `${e.code}/${e.detail}`).join(";") ?? "-"}  ` +
      `order=${p.order_id}  id=${p.id}`,
  );
}
console.log("\ndone.");
