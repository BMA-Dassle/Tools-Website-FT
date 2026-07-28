/**
 * Owner's question (2026-07-28): if we ADJUST_INCREMENT the gift card to put
 * the value back ourselves, can we still refund that gift card?
 *
 * Context: an order-linked (itemized) refund does not credit a gift-card
 * tender. LOAD was rejected without a buyer_payment_instrument_id. But
 * ADJUST_INCREMENT is already proven in production (lane-open gap-comp). So:
 *
 *   1. GC-paid order, itemized refund → confirm no credit
 *   2. ADJUST_INCREMENT the card by that amount   ← does it work?
 *   3. Refund MORE of the same payment (plain)    ← still allowed after a manual increment?
 *   4. SPEND the card on a new order              ← is the incremented value real/usable?
 *
 * Non-accounting location; card left ACTIVE. DRY RUN by default.
 *   npx tsx scripts/gc-increment-then-refund-probe.mts --live
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const LIVE = process.argv.includes("--live");
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const LOC = "6MZJFTGAYD7TC";
const K = `inc-${randomUUID().slice(0, 8)}`;
if (!LIVE) {
  console.log("DRY RUN — pass --live. Would: itemized refund → ADJUST_INCREMENT → refund again → spend.");
  process.exit(0);
}
/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(m: string, p: string, b?: unknown) {
  const res = await fetch(`${BASE}${p}`, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) });
  let j: any = null;
  try { j = await res.json(); } catch { /* empty */ }
  return { ok: res.ok && !(j?.errors?.length > 0), json: j, err: JSON.stringify(j?.errors ?? "").slice(0, 160) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let gc: string | undefined;
const bal = async () => (await sq("GET", `/gift-cards/${gc}`)).json?.gift_card?.balance_money?.amount ?? 0;
const out: string[] = [];

try {
  const c = await sq("POST", "/gift-cards", {
    idempotency_key: `${K}-c`, location_id: LOC,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan: `WEBINC${Date.now().toString().slice(-10)}` },
  });
  if (!c.ok) throw new Error(`card ${c.err}`);
  gc = c.json.gift_card.id;

  const o = await sq("POST", "/orders", {
    idempotency_key: `${K}-o`,
    order: {
      location_id: LOC,
      line_items: [
        { uid: "A", name: "Lane", quantity: "1", base_price_money: { amount: 1500, currency: "USD" } },
        { uid: "B", name: "Soda", quantity: "1", base_price_money: { amount: 600, currency: "USD" } },
      ],
      taxes: [{ uid: "T", name: "Tax", percentage: "7", scope: "ORDER" }],
    },
  });
  if (!o.ok) throw new Error(`order ${o.err}`);
  const oid = o.json.order.id, total = o.json.order.total_money.amount;

  const co = await sq("POST", "/orders", {
    idempotency_key: `${K}-co`,
    order: {
      location_id: LOC,
      line_items: [{ name: "eGC", quantity: "1", item_type: "GIFT_CARD", base_price_money: { amount: total, currency: "USD" } }],
      discounts: [{ name: "comp", amount_money: { amount: total, currency: "USD" }, scope: "ORDER" }],
    },
  });
  await sq("POST", `/orders/${co.json.order.id}/pay`, { idempotency_key: `${K}-cp`, payment_ids: [] });
  await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${K}-a`,
    gift_card_activity: {
      type: "ACTIVATE", location_id: LOC, gift_card_id: gc,
      activate_activity_details: { order_id: co.json.order.id, line_item_uid: co.json.order.line_items[0].uid },
    },
  });
  const pay = await sq("POST", "/payments", {
    idempotency_key: `${K}-p`, source_id: gc,
    amount_money: { amount: total, currency: "USD" }, order_id: oid, location_id: LOC, autocomplete: true,
  });
  if (!pay.ok) throw new Error(`pay ${pay.err}`);
  const pid = pay.json.payment.id;
  console.log(`order ${total}¢ paid from card; baseline ${await bal()}¢`);

  // 1. itemized refund
  const ret = await sq("POST", "/orders", {
    idempotency_key: `${K}-r`,
    order: { location_id: LOC, returns: [{ source_order_id: oid, return_line_items: [{ uid: "R", source_line_item_uid: "B", quantity: "1" }] }] },
  });
  const amt = ret.json.order.return_amounts.total_money.amount;
  const rf = await sq("POST", "/refunds", {
    idempotency_key: `${K}-rf`, payment_id: pid,
    amount_money: { amount: amt, currency: "USD" }, order_id: ret.json.order.id, reason: "Probe itemized",
  });
  if (!rf.ok) throw new Error(`itemized ${rf.err}`);
  await sleep(25000);
  const b1 = await bal();
  out.push(`itemized refund ${amt}¢ → card ${b1}¢ (${b1 > 0 ? "credited" : "NOT credited"})`);

  // 2. ADJUST_INCREMENT to put the value back ourselves
  const inc = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${K}-inc`,
    gift_card_activity: {
      type: "ADJUST_INCREMENT", location_id: LOC, gift_card_id: gc,
      adjust_increment_activity_details: { amount_money: { amount: amt, currency: "USD" }, reason: "COMPLIMENTARY" },
    },
  });
  const b2 = await bal();
  out.push(inc.ok ? `ADJUST_INCREMENT ${amt}¢ ACCEPTED → card ${b1}¢ → ${b2}¢` : `ADJUST_INCREMENT REFUSED ${inc.err}`);

  // 3. can we STILL refund more of the same payment after a manual increment?
  const rest = 500;
  const rf2 = await sq("POST", "/refunds", {
    idempotency_key: `${K}-rf2`, payment_id: pid,
    amount_money: { amount: rest, currency: "USD" }, reason: "Probe plain after increment",
  });
  out.push(rf2.ok ? `plain refund ${rest}¢ AFTER the increment: ACCEPTED` : `plain refund AFTER increment REFUSED ${rf2.err}`);
  if (rf2.ok) {
    await sleep(20000);
    const b3 = await bal();
    out.push(`  → card ${b2}¢ → ${b3}¢ (${b3 > b2 ? "credited on top of the increment" : "no credit"})`);
  }

  // 4. is the incremented value actually spendable?
  const b4 = await bal();
  if (b4 >= 300) {
    const o2 = await sq("POST", "/orders", {
      idempotency_key: `${K}-o2`,
      order: { location_id: LOC, line_items: [{ name: "Spend test", quantity: "1", base_price_money: { amount: 300, currency: "USD" } }] },
    });
    const p2 = await sq("POST", "/payments", {
      idempotency_key: `${K}-p2`, source_id: gc,
      amount_money: { amount: 300, currency: "USD" }, order_id: o2.json.order.id, location_id: LOC, autocomplete: true,
    });
    out.push(p2.ok ? `SPEND 300¢ from the incremented card: ACCEPTED (value is real)` : `SPEND REFUSED ${p2.err}`);
    if (p2.ok) {
      await sq("POST", "/refunds", {
        idempotency_key: `${K}-p2r`, payment_id: p2.json.payment.id,
        amount_money: { amount: 300, currency: "USD" }, reason: "Refund: Reservation Deposit",
      });
    }
  }
} catch (e) {
  out.push(`ABORTED: ${e instanceof Error ? e.message : e}`);
} finally {
  if (gc) {
    await sleep(15000);
    const b = await bal();
    if (b > 0) {
      await sq("POST", "/gift-cards/activities", {
        idempotency_key: `${K}-d`,
        gift_card_activity: {
          type: "ADJUST_DECREMENT", location_id: LOC, gift_card_id: gc,
          adjust_decrement_activity_details: { amount_money: { amount: b, currency: "USD" }, reason: "PURCHASE_WAS_REFUNDED" },
        },
      });
    }
    console.log(`\ncleanup: drained ${b}¢; card ${gc} left ACTIVE`);
  }
}
console.log("\n═══ FINDINGS ═══");
for (const f of out) console.log(`• ${f}`);
