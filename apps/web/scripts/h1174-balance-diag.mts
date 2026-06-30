/** READ-ONLY diagnostic for a GF quote by contract short id (e.g. H1174).
 *  Compares the balance the system WILL charge against the day-of Square order,
 *  the deposit, the gift cards, and the universal collected/total invariant.
 *  No writes. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const SHORT_ID = process.argv[2] ?? "H1174";
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const d = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`;
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;
async function getOrder(id: string) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, order: (j as { order?: Record<string, unknown> }).order };
}

const { getGfQuoteByShortId } = await import("@/lib/group-function-db");
const { serviceChargeCentsFromLineItems } = await import("@/lib/service-charge");

const quote = await getGfQuoteByShortId(SHORT_ID);
if (!quote) {
  console.error(`No group_function_quotes row for contract_short_id=${SHORT_ID}`);
  process.exit(1);
}

console.log("══════════ QUOTE ══════════");
console.log(`id              ${quote.id}`);
console.log(`event           ${quote.event_name ?? ""}  (#${quote.event_number ?? ""})`);
console.log(`center          ${quote.center_code}  loc=${quote.square_location_id}`);
console.log(`bmi_reservation ${quote.bmi_reservation_id}`);
console.log(`status          ${quote.status}`);
console.log(`event_date      ${quote.event_date}`);
console.log(`tax_exempt      ${quote.is_tax_exempt}`);
console.log("");
console.log(`total_cents       ${d(quote.total_cents)}`);
console.log(`tax_cents         ${d(quote.tax_cents)}`);
console.log(`deposit_due_cents ${d(quote.deposit_due_cents)}`);
console.log(`balance_cents     ${d(quote.balance_cents)}   ← what it WILL charge`);
console.log(`collected_cents   ${d(quote.collected_cents)}`);
console.log(`balance_paid_at   ${quote.balance_paid_at ?? "(unpaid)"}`);
console.log(`saved_card        ${quote.saved_card_id ? `${quote.saved_card_brand} ****${quote.saved_card_last4}` : "(none → pay link)"}`);
console.log(`balance_last_err  ${quote.balance_last_error ?? ""}`);

const svc = serviceChargeCentsFromLineItems(quote.line_items);
console.log(`\nservice charge from line_items = ${d(svc)}`);

console.log("\n── line items (quote) ──");
for (const li of quote.line_items as Array<Record<string, unknown>>) {
  console.log(`  ${JSON.stringify(li)}`);
}

// Invariant checks
console.log("\n══════════ INVARIANTS ══════════");
const expectedBalance = quote.total_cents - quote.collected_cents;
console.log(`total - collected = ${d(expectedBalance)}   vs balance_cents ${d(quote.balance_cents)}  ${expectedBalance === quote.balance_cents ? "✅ match" : "❌ MISMATCH"}`);
console.log(`deposit + balance = ${d(quote.deposit_due_cents + quote.balance_cents)}   vs total ${d(quote.total_cents)}  ${quote.deposit_due_cents + quote.balance_cents === quote.total_cents ? "✅" : "⚠️ (ok if collected≠deposit)"}`);

// Day-of order
if (quote.square_dayof_order_id) {
  const { ok, status, order } = await getOrder(quote.square_dayof_order_id);
  console.log(`\n══════════ DAY-OF ORDER ${quote.square_dayof_order_id} ══════════`);
  if (!ok || !order) {
    console.log(`  fetch failed HTTP ${status}`);
  } else {
    const li = (order.line_items ?? []) as Array<Record<string, unknown>>;
    console.log(`  state=${order.state}  total=${d(money(order.total_money))}  tax=${d(money(order.total_tax_money))}  svc=${d(money(order.total_service_charge_money))}  due=${d(money(order.net_amount_due_money))}`);
    for (const l of li) {
      console.log(`    • ${l.quantity}× "${l.name}" base=${d(money(l.base_price_money))} gross=${d(money(l.gross_sales_money))} total=${d(money(l.total_money))} catalog=${l.catalog_object_id ?? "-"}`);
    }
    for (const t of (order.tenders ?? []) as Array<Record<string, unknown>>) {
      console.log(`    tender type=${t.type} amount=${d(money(t.amount_money))}`);
    }
    console.log(`\n  >>> day-of total ${d(money(order.total_money))}  vs quote total ${d(quote.total_cents)}  ${money(order.total_money) === quote.total_cents ? "✅ match" : "❌ MISMATCH — this is likely the problem"}`);
  }
}

// Deposit order
if (quote.square_deposit_order_id) {
  const { order } = await getOrder(quote.square_deposit_order_id);
  if (order) {
    console.log(`\n── deposit order ${quote.square_deposit_order_id} ──`);
    console.log(`  state=${order.state} total=${d(money(order.total_money))}`);
    for (const t of (order.tenders ?? []) as Array<Record<string, unknown>>) {
      console.log(`    tender type=${t.type} amount=${d(money(t.amount_money))}`);
    }
  }
}

// Gift cards
const { parseGiftCardIds, parseGiftCardGans } = await import("@/lib/group-function-db");
const gcIds = parseGiftCardIds(quote.square_gift_card_id);
const gcGans = parseGiftCardGans(quote.square_gift_card_gan);
console.log(`\n── gift cards (${gcIds.length}) ──`);
let gcTotal = 0;
for (let i = 0; i < gcIds.length; i++) {
  const res = await fetch(`${BASE}/gift-cards/${gcIds[i]}`, { headers: H });
  const j = (await res.json().catch(() => ({}))) as { gift_card?: { state?: string; balance_money?: { amount?: number }; gan?: string } };
  const bal = money(j.gift_card?.balance_money);
  gcTotal += bal;
  console.log(`  [${i}] ${gcIds[i]} gan=${gcGans[i] ?? j.gift_card?.gan ?? "?"} state=${j.gift_card?.state} balance=${d(bal)}`);
}
console.log(`  gift-card total balance = ${d(gcTotal)}`);
console.log(`\n  >>> gift cards ${d(gcTotal)} + balance to charge ${d(quote.balance_cents)} = ${d(gcTotal + quote.balance_cents)}  vs day-of total needed`);

process.exit(0);
