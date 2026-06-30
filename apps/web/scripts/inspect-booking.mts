/** READ-ONLY: resolve a booking by BMI bill id → inspect its Square deposit
 *  order classification + the funded gift card. No writes. BMI bill id is kept
 *  as a string throughout (never Number()) per the precision rule. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const BILL_ID = process.argv[2] ?? "63000000003873040";
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;
async function getJson(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

const { sql } = await import("@/lib/db");
const q = sql();
const rows = (await q`
  SELECT id, product_kind, status, square_deposit_order_id AS dep_order,
         square_dayof_order_id AS dayof_order, square_gift_card_id AS gc_id,
         square_gift_card_gan AS gc_gan, deposit_cents, total_cents
  FROM bowling_reservations
  WHERE bmi_bill_id = ${BILL_ID}
  ORDER BY id DESC
`) as Array<Record<string, unknown>>;

if (!rows.length) {
  console.error(`No bowling_reservations row for bmi_bill_id=${BILL_ID}`);
  process.exit(1);
}
const r = rows[0];
console.log("══════════ NEON RESERVATION ══════════");
console.log(`neonId        ${r.id}`);
console.log(`product_kind  ${r.product_kind}`);
console.log(`status        ${r.status}`);
console.log(`deposit_cents ${r.deposit_cents}   total_cents ${r.total_cents}`);
console.log(`deposit_order ${r.dep_order}`);
console.log(`dayof_order   ${r.dayof_order}`);
console.log(`gift_card_id  ${r.gc_id}`);
console.log(`gift_card_gan ${r.gc_gan}`);

if (r.dep_order) {
  const o = (await getJson(`/orders/${r.dep_order}`)).data as { order?: Record<string, unknown> };
  const order = o.order;
  if (order) {
    const lineItems = (order.line_items ?? []) as Array<Record<string, unknown>>;
    console.log("\n══════════ DEPOSIT ORDER ══════════");
    console.log(`state ${order.state}   reference ${order.reference_id ?? ""}`);
    console.log(`total ${money(order.total_money)}   net_sales ${money((order.net_amounts as Record<string, unknown>)?.total_money)}`);
    for (const li of lineItems) {
      console.log(
        `  • "${li.name}"  item_type=${li.item_type}  base=${money(li.base_price_money)}  gross_sales=${money(li.gross_sales_money)}`,
      );
    }
    for (const t of (order.tenders ?? []) as Array<Record<string, unknown>>) {
      console.log(`  tender type=${t.type} amount=${money(t.amount_money)}`);
    }
    const giftCardLine = lineItems.find((li) => li.item_type === "GIFT_CARD");
    console.log("\n══════════ VERDICT ══════════");
    if (giftCardLine) {
      console.log("✅ DEPOSIT_GC_SALE_V2 ON — deposit line is item_type=GIFT_CARD → booked as a");
      console.log("   GIFT-CARD SALE (excluded from gross sales → no double-count). New flow worked.");
    } else {
      console.log("⚠️  Deposit line is a plain ITEM → legacy path. Flag was OFF on this deploy.");
    }
  }
}

if (r.gc_id && typeof r.gc_id === "string" && r.gc_id.startsWith("gftc")) {
  const gc = (await getJson(`/gift-cards/${r.gc_id}`)).data as {
    gift_card?: { state?: string; balance_money?: { amount?: number }; gan?: string };
  };
  console.log("\n── funded gift card ──");
  console.log(
    `state=${gc.gift_card?.state} balance=${money(gc.gift_card?.balance_money)} gan=${gc.gift_card?.gan}`,
  );
}
process.exit(0);
