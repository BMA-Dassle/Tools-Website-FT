/**
 * READ-ONLY diagnosis for a group-function balance-charge failure.
 * node --env-file=.env.local __gf_diag_tmp.mjs <search>
 * Searches the quote, then inspects Square: balance order/payment,
 * gift card balance, saved card, and recent customer payments
 * (to detect whether the already-sent payment link was paid).
 * Moves NO money. Delete when done.
 */
import { neon } from "@neondatabase/serverless";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const TOK = process.env.SQUARE_ACCESS_TOKEN || "";
const H = {
  Authorization: `Bearer ${TOK}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const j = (o) => JSON.stringify(o, null, 2);
const search = process.argv[2] || "1145";

const sql = neon(process.env.DATABASE_URL);

const rows = await sql`
  SELECT * FROM group_function_quotes
  WHERE event_number ILIKE ${"%" + search + "%"}
     OR contract_short_id ILIKE ${"%" + search + "%"}
     OR event_name ILIKE ${"%" + search + "%"}
     OR guest_last_name ILIKE ${"%" + search + "%"}
     OR square_gift_card_gan ILIKE ${"%" + search + "%"}
  ORDER BY created_at DESC
  LIMIT 5`;

console.log(`\n=== group_function_quotes matches for "${search}": ${rows.length} ===`);
for (const q of rows) {
  console.log(`\n--- quote id=${q.id} ---`);
  console.log(`  event            : ${q.event_name}  (#${q.event_number})`);
  console.log(
    `  guest            : ${q.guest_first_name} ${q.guest_last_name} / ${q.guest_phone} / ${q.guest_email}`,
  );
  console.log(`  center           : ${q.center_code}  loc=${q.square_location_id}`);
  console.log(`  status           : ${q.status}`);
  console.log(`  total_cents      : ${q.total_cents}  ($${(q.total_cents / 100).toFixed(2)})`);
  console.log(`  balance_cents    : ${q.balance_cents}  ($${(q.balance_cents / 100).toFixed(2)})`);
  console.log(`  deposit_paid_at  : ${q.deposit_paid_at}`);
  console.log(`  event_date       : ${q.event_date}`);
  console.log(
    `  saved_card_id    : ${q.saved_card_id}  (${q.saved_card_brand} ****${q.saved_card_last4})`,
  );
  console.log(`  square_customer  : ${q.square_customer_id}`);
  console.log(`  gift_card_id     : ${q.square_gift_card_id}`);
  console.log(`  gift_card_gan    : ${q.square_gift_card_gan}`);
  console.log(`  dayof_order_id   : ${q.square_dayof_order_id}`);
  console.log(`  BAL order_id     : ${q.square_balance_order_id}`);
  console.log(`  BAL payment_id   : ${q.square_balance_payment_id}`);
  console.log(`  balance_paid_at  : ${q.balance_paid_at}`);
  console.log(`  balance_method   : ${q.balance_payment_method}`);
  console.log(`  balance_attempts : ${q.balance_charge_attempts}`);
  console.log(`  balance_last_err : ${q.balance_last_error}`);
  console.log(`  link_sent_at     : ${q.balance_link_sent_at}`);
  console.log(`  link_url         : ${q.balance_payment_link_url}`);
}

const q = rows[0];
if (!q) process.exit(0);

// Gift card current balance
async function gcBalance(id) {
  if (!id) return;
  const r = await fetch(`${SQUARE_BASE}/gift-cards/${id}`, { headers: H });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return console.log(`\n[gift card] error ${r.status} ${j(d).slice(0, 200)}`);
  const gc = d.gift_card || {};
  console.log(`\n=== gift card ${id} ===`);
  console.log(
    `  gan=${gc.gan} state=${gc.state} balance=${gc.balance_money?.amount ?? 0}c ($${((gc.balance_money?.amount ?? 0) / 100).toFixed(2)})`,
  );
}
await gcBalance(q.square_gift_card_id);

// Saved card on file — is it still usable?
async function savedCard(custId, cardId) {
  if (!custId || !cardId) return;
  const r = await fetch(`${SQUARE_BASE}/cards/${cardId}`, { headers: H });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return console.log(`\n[saved card] error ${r.status} ${j(d).slice(0, 200)}`);
  const c = d.card || {};
  console.log(`\n=== saved card ${cardId} ===`);
  console.log(
    `  ${c.card_brand} ****${c.last_4} exp ${c.exp_month}/${c.exp_year} enabled=${c.enabled} state=${c.merchant_id ? "" : ""}${c.card_type || ""} customer=${c.customer_id}`,
  );
}
await savedCard(q.square_customer_id, q.saved_card_id);

// Recent payments for this customer — did the link get paid? Was the card already charged?
async function recentPayments(custId) {
  if (!custId) return;
  const begin = new Date(
    new Date(q.deposit_paid_at || Date.now()).getTime() - 86400000,
  ).toISOString();
  const r = await fetch(
    `${SQUARE_BASE}/payments?location_id=${q.square_location_id}&begin_time=${encodeURIComponent(begin)}&sort_order=DESC&limit=100`,
    { headers: H },
  );
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return console.log(`\n[payments] error ${r.status} ${j(d).slice(0, 200)}`);
  const mine = (d.payments || []).filter((p) => p.customer_id === custId);
  console.log(
    `\n=== Square payments for customer ${custId} (since ${begin.slice(0, 10)}): ${mine.length} ===`,
  );
  for (const p of mine) {
    console.log(
      `  ${p.created_at} ${p.status} $${((p.amount_money?.amount ?? 0) / 100).toFixed(2)} id=${p.id} order=${p.order_id} src=${p.source_type} note="${p.note || ""}"`,
    );
  }
}
await recentPayments(q.square_customer_id);

// If a balance order was ever created, show its state + payments
async function orderState(orderId, label) {
  if (!orderId) return;
  const r = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: H });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return console.log(`\n[${label} order] error ${r.status}`);
  const o = d.order || {};
  console.log(`\n=== ${label} order ${orderId} ===`);
  console.log(
    `  state=${o.state} total=${o.total_money?.amount ?? 0}c paid=${o.total_money?.amount - (o.net_amount_due_money?.amount ?? 0)}c due=${o.net_amount_due_money?.amount ?? 0}c`,
  );
  for (const t of o.tenders || [])
    console.log(
      `    tender ${t.type} $${((t.amount_money?.amount ?? 0) / 100).toFixed(2)} payment=${t.payment_id}`,
    );
}
await orderState(q.square_balance_order_id, "BALANCE");
