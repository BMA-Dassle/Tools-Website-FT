/**
 * One-off remediation for quote id=10 (#H1145, Angelina birthday).
 * Charges the REMAINING balance ($791.13 — deposit+comp already on the
 * card cover the other half), loads it onto the gift card, advances
 * status to balance_charged. Mirrors group-balance-charge Path A.
 *
 *   node --env-file=.env.local __gf_charge_tmp.mjs        # dry run (default)
 *   node --env-file=.env.local __gf_charge_tmp.mjs --go   # execute
 *
 * Idempotent: fixed keys, so a re-run never double-charges. Delete when done.
 */
import { neon } from "@neondatabase/serverless";

const GO = process.argv.includes("--go");
const SQUARE_BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const j = (o) => JSON.stringify(o, null, 2);
const sql = neon(process.env.DATABASE_URL);

const CHARGE_CENTS = 79113; // $791.13 remaining to fund the event
const TARGET_GC_CENTS = 158226; // gift card should land here ($1,582.26)
const KEY = "gf10-balfix-20260607"; // stable idempotency base

const [q] = await sql`SELECT * FROM group_function_quotes WHERE id = 10`;
if (!q) {
  console.error("quote 10 not found");
  process.exit(1);
}

// ── Guards ──────────────────────────────────────────────────────────
const fail = (m) => {
  console.error("ABORT:", m);
  process.exit(1);
};
if (!["balance_link_sent", "deposit_paid"].includes(q.status))
  fail(`unexpected status ${q.status}`);
if (q.square_balance_payment_id)
  fail(`balance already charged: payment ${q.square_balance_payment_id}`);
if (q.balance_paid_at) fail(`balance_paid_at already set: ${q.balance_paid_at}`);
if (!q.saved_card_id || !q.square_customer_id) fail("missing saved card / customer");
const gcId = JSON.parse(q.square_gift_card_id)[0];

// Re-verify gift card balance right now (must be 791.13 before we load)
const gcNow = await (
  await fetch(`${SQUARE_BASE}/gift-cards/${encodeURIComponent(gcId)}`, { headers: H })
).json();
const gcBal = gcNow.gift_card?.balance_money?.amount ?? -1;
console.log(`gift card ${gcId} balance now = $${(gcBal / 100).toFixed(2)}`);
if (gcBal + CHARGE_CENTS !== TARGET_GC_CENTS)
  fail(`load math off: ${gcBal} + ${CHARGE_CENTS} != ${TARGET_GC_CENTS}`);

console.log(`\nPLAN: charge $${(CHARGE_CENTS / 100).toFixed(2)} to ${q.saved_card_id}`);
console.log(
  `      load  $${(CHARGE_CENTS / 100).toFixed(2)} onto gift card -> $${(TARGET_GC_CENTS / 100).toFixed(2)}`,
);
console.log(`      set status=balance_charged, balance_cents=0\n`);
if (!GO) {
  console.log("DRY RUN — pass --go to execute.");
  process.exit(0);
}

// ── 1. Balance order ────────────────────────────────────────────────
const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    idempotency_key: `${KEY}-order`,
    order: {
      location_id: q.square_location_id,
      reference_id: `GF Balance: ${q.event_number || ""}`.slice(0, 40),
      line_items: [
        {
          name: "Group Event Balance",
          quantity: "1",
          base_price_money: { amount: CHARGE_CENTS, currency: "USD" },
        },
      ],
    },
  }),
});
const orderData = await orderRes.json();
if (!orderRes.ok || !orderData.order?.id) fail(`order failed: ${j(orderData).slice(0, 300)}`);
const balanceOrderId = orderData.order.id;
console.log(`order ok: ${balanceOrderId}`);

// ── 2. Charge saved card ────────────────────────────────────────────
const payRes = await fetch(`${SQUARE_BASE}/payments`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    idempotency_key: `${KEY}-pay`,
    source_id: q.saved_card_id,
    amount_money: { amount: CHARGE_CENTS, currency: "USD" },
    order_id: balanceOrderId,
    location_id: q.square_location_id,
    customer_id: q.square_customer_id,
    autocomplete: true,
    note: `GF Balance: ${q.event_name || ""} (${q.event_number || ""})`,
  }),
});
const payData = await payRes.json();
if (!payRes.ok || payData.errors)
  fail(`charge failed: ${j(payData.errors || payData).slice(0, 300)}`);
const balancePaymentId = payData.payment?.id;
console.log(
  `charge ok: payment ${balancePaymentId} status=${payData.payment?.status} $${((payData.payment?.amount_money?.amount ?? 0) / 100).toFixed(2)} card ****${payData.payment?.card_details?.card?.last_4}`,
);

// ── 3. Load gift card ───────────────────────────────────────────────
const loadRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    idempotency_key: `${KEY}-load`,
    gift_card_activity: {
      type: "LOAD",
      location_id: q.square_location_id,
      gift_card_id: gcId,
      load_activity_details: {
        amount_money: { amount: CHARGE_CENTS, currency: "USD" },
        buyer_payment_instrument_ids: [balancePaymentId],
      },
    },
  }),
});
const loadData = await loadRes.json();
if (!loadRes.ok || loadData.errors)
  fail(`gift card load failed: ${j(loadData.errors || loadData).slice(0, 300)}`);
const newBal = loadData.gift_card_activity?.gift_card_balance_money?.amount ?? 0;
console.log(`load ok: gift card balance now $${(newBal / 100).toFixed(2)}`);
if (newBal !== TARGET_GC_CENTS)
  console.warn(`WARNING: balance ${newBal} != target ${TARGET_GC_CENTS}`);

// ── 4. Advance DB state ─────────────────────────────────────────────
await sql`
  UPDATE group_function_quotes SET
    square_balance_order_id = ${balanceOrderId},
    square_balance_payment_id = ${balancePaymentId},
    balance_paid_at = NOW(),
    balance_payment_method = 'manual_card',
    balance_last_error = NULL,
    balance_cents = 0,
    status = 'balance_charged',
    updated_at = NOW()
  WHERE id = 10`;
console.log(`\nDB updated: status=balance_charged, balance_cents=0`);
console.log(`DONE.`);
