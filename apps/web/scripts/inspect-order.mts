/** READ-ONLY: inspect a Square order/transaction to verify the deposit
 *  gift-card-sale flow. Resolves the dashboard id as an order id first, then
 *  falls back to treating it as a payment id. Prints line-item types, sale
 *  classification, tenders, and any linked gift card. No writes. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const ID = process.argv[2] ?? "nbW2uXB1J1dNGwpZ79ub8bcJ8DNZY";

async function getJson(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

let order: Record<string, unknown> | undefined;

const asOrder = await getJson(`/orders/${ID}`);
if (asOrder.ok && (asOrder.data as { order?: unknown }).order) {
  order = (asOrder.data as { order: Record<string, unknown> }).order;
} else {
  console.log(`Not an order id (HTTP ${asOrder.status}); trying as payment id…`);
  const pay = await getJson(`/payments/${ID}`);
  const orderId = (pay.data as { payment?: { order_id?: string } }).payment?.order_id;
  console.log(`payment.order_id = ${orderId ?? "(none)"}`);
  if (orderId) {
    const o = await getJson(`/orders/${orderId}`);
    order = (o.data as { order?: Record<string, unknown> }).order;
  }
}

if (!order) {
  console.error("Could not resolve an order from that id.");
  process.exit(1);
}

const lineItems = (order.line_items ?? []) as Array<Record<string, unknown>>;
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;

console.log("\n══════════ ORDER ══════════");
console.log(`id           ${order.id}`);
console.log(`location     ${order.location_id}`);
console.log(`state        ${order.state}`);
console.log(`reference    ${order.reference_id ?? ""}`);
console.log(`source       ${(order.source as { name?: string })?.name ?? ""}`);
console.log(`total_money  ${money(order.total_money)}`);
console.log(
  `net_amounts  sales=${money((order.net_amounts as Record<string, unknown>)?.total_money)}`,
);

console.log("\n── line items ──");
for (const li of lineItems) {
  console.log(
    `  • "${li.name}"  item_type=${li.item_type ?? "(plain ITEM/CUSTOM)"}  ` +
      `base=${money(li.base_price_money)}  gross_sales=${money(li.gross_sales_money)}  ` +
      `total=${money(li.total_money)}`,
  );
}

const tenders = (order.tenders ?? []) as Array<Record<string, unknown>>;
console.log("\n── tenders ──");
for (const t of tenders) {
  console.log(`  • type=${t.type}  amount=${money(t.amount_money)}  id=${t.id}`);
}

// Verdict on the gift-card-sale classification
const giftCardLine = lineItems.find((li) => li.item_type === "GIFT_CARD");
console.log("\n══════════ VERDICT ══════════");
if (giftCardLine) {
  console.log("✅ Deposit line item is item_type=GIFT_CARD → booked as a GIFT-CARD SALE.");
  console.log("   (Excluded from gross sales → no double-count with the day-of order.)");
  console.log("   This means DEPOSIT_GC_SALE_V2 was ON and the new flow ran.");
} else if (lineItems.length) {
  console.log("⚠️  Deposit line item is a plain sale (no item_type=GIFT_CARD).");
  console.log("   The legacy path ran — DEPOSIT_GC_SALE_V2 was OFF on this environment.");
}
