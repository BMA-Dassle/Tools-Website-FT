/**
 * Owner's idea (2026-07-28): if the ITEMIZED refund does not credit the gift
 * card, can we just LOAD the card ourselves for the same amount? That would
 * decouple the two requirements — item-level attribution from the return
 * order, and the money landing on the card from an explicit LOAD.
 *
 * Also settles the follow-on question that falls out of it: the chain is
 *   day-of refund → GC credited → deposit refund → GC decremented
 * and the credit + decrement CANCEL. So if the itemized refund never credits
 * the card, is the load even needed, or can both the load and the decrement
 * simply be skipped, leaving the card at its correct end state of 0?
 *
 * Method, one card, clean 0 baseline after payment:
 *   1. itemized refund of a line (linked to a return order)
 *   2. confirm the card is NOT credited
 *   3. LOAD the card for the same amount   ← the owner's question
 *   4. report whether the load lands and what the payment/card end state is
 *
 * Non-accounting location. Card left ACTIVE at the end. DRY RUN by default:
 *   npx tsx scripts/gc-itemized-plus-load-probe.mts --live
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
const LOCATION = "6MZJFTGAYD7TC";
const KEY = `ipl-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: GC-paid order → itemized refund → confirm no credit → LOAD the card");
  process.exit(0);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}
const errStr = (r: { status: number; json: any }) =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 250)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let giftCardId: string | undefined;
const bal = async () =>
  (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.balance_money?.amount ?? 0;
const findings: string[] = [];

try {
  const gan = `WEBIPL${Date.now().toString().slice(-10)}`;
  const create = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan },
  });
  if (!create.ok) throw new Error(`card: ${errStr(create)}`);
  giftCardId = create.json.gift_card.id as string;

  const o = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-o`,
    order: {
      location_id: LOCATION,
      line_items: [
        { uid: "A", name: "Lane time", quantity: "1", base_price_money: { amount: 1500, currency: "USD" } },
        { uid: "B", name: "Soda", quantity: "1", base_price_money: { amount: 600, currency: "USD" } },
      ],
      taxes: [{ uid: "TX", name: "Tax", percentage: "7", scope: "ORDER" }],
      fulfillments: [
        { type: "PICKUP", state: "PROPOSED", pickup_details: { recipient: { display_name: "Probe" }, schedule_type: "ASAP" } },
      ],
    },
  });
  if (!o.ok) throw new Error(`order: ${errStr(o)}`);
  const orderId = o.json.order.id as string;
  const total = o.json.order.total_money?.amount ?? 0;

  const co = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-co`,
    order: {
      location_id: LOCATION,
      line_items: [
        { name: "eGiftCard (funding)", quantity: "1", item_type: "GIFT_CARD", base_price_money: { amount: total, currency: "USD" } },
      ],
      discounts: [{ name: "Probe comp", amount_money: { amount: total, currency: "USD" }, scope: "ORDER" }],
    },
  });
  if (!co.ok) throw new Error(`comp: ${errStr(co)}`);
  await sq("POST", `/orders/${co.json.order.id}/pay`, { idempotency_key: `${KEY}-cp`, payment_ids: [] });
  await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-act`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION,
      gift_card_id: giftCardId,
      activate_activity_details: { order_id: co.json.order.id, line_item_uid: co.json.order.line_items[0].uid },
    },
  });

  const pay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-p`,
    source_id: giftCardId,
    amount_money: { amount: total, currency: "USD" },
    order_id: orderId,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!pay.ok) throw new Error(`payment: ${errStr(pay)}`);
  const paymentId = pay.json.payment.id as string;
  console.log(`order ${total}¢ paid from the card; baseline ${await bal()}¢`);

  // 1. Itemized refund
  const ret = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-ret`,
    order: {
      location_id: LOCATION,
      returns: [{ source_order_id: orderId, return_line_items: [{ uid: "R0", source_line_item_uid: "B", quantity: "1" }] }],
    },
  });
  if (!ret.ok) throw new Error(`return: ${errStr(ret)}`);
  const amt = ret.json.order.return_amounts?.total_money?.amount ?? 0;
  const rf = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r1`,
    payment_id: paymentId,
    amount_money: { amount: amt, currency: "USD" },
    order_id: ret.json.order.id,
    reason: "Probe: itemized",
  });
  if (!rf.ok) throw new Error(`itemized refund: ${errStr(rf)}`);
  const itemRefundId = rf.json.refund.id as string;

  // WHERE does an itemized refund send the money? The refund object names its
  // own destination — if it is not the gift card, that explains the missing
  // credit outright.
  const rfFull = (await sq("GET", `/refunds/${itemRefundId}`)).json?.refund;
  findings.push(
    `ITEMIZED refund destination_type=${rfFull?.destination_type ?? "none"} ` +
      `destination_details=${JSON.stringify(rfFull?.destination_details ?? null)} ` +
      `status=${rfFull?.status} order_id=${rfFull?.order_id ?? "none"}`,
  );
  console.log(
    `itemized refund destination_type=${rfFull?.destination_type ?? "none"} status=${rfFull?.status}`,
  );

  // What the payment itself says its tender was, for comparison.
  const payFull = (await sq("GET", `/payments/${paymentId}`)).json?.payment;
  findings.push(
    `source payment source_type=${payFull?.source_type} ` +
      `gift_card_details=${JSON.stringify(payFull?.gift_card_details ?? null)}`,
  );

  await sleep(30000);
  const afterRefund = await bal();

  // Every activity Square recorded on the card — a REFUND activity would prove
  // the credit was at least attempted.
  const acts = (
    await sq("GET", `/gift-cards/activities?gift_card_id=${encodeURIComponent(giftCardId)}&limit=30`)
  ).json?.gift_card_activities;
  findings.push(
    `card activities after the itemized refund: [${(acts ?? []).map((a: any) => a.type).join(", ")}]`,
  );
  findings.push(`itemized refund ${amt}¢ → card ${afterRefund}¢ (credit ${afterRefund > 0 ? "landed" : "did NOT land"})`);
  console.log(`itemized refund ${amt}¢ issued; card at ${afterRefund}¢ after 30s`);

  // 2. THE OWNER'S QUESTION: load the card ourselves for the same amount.
  const load = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-load`,
    gift_card_activity: {
      type: "LOAD",
      location_id: LOCATION,
      gift_card_id: giftCardId,
      load_activity_details: {
        amount_money: { amount: amt, currency: "USD" },
        buyer_payment_instrument_ids: [],
      },
    },
  });
  const afterLoad = await bal();
  findings.push(
    load.ok
      ? `explicit LOAD ${amt}¢ ACCEPTED → card ${afterRefund}¢ → ${afterLoad}¢ — the owner's approach WORKS`
      : `explicit LOAD REFUSED — ${errStr(load)}`,
  );
  console.log(`LOAD → ${load.ok ? `ok, card now ${afterLoad}¢` : errStr(load)}`);

  const p = (await sq("GET", `/payments/${paymentId}`)).json?.payment;
  findings.push(
    `end state: payment refunded ${p?.refunded_money?.amount ?? 0}¢ of ${total}¢, card ${afterLoad}¢`,
  );
} catch (e) {
  console.log(`\naborted: ${e instanceof Error ? e.message : e}`);
  findings.push(`ABORTED: ${e instanceof Error ? e.message : e}`);
} finally {
  if (giftCardId) {
    await sleep(10000);
    const b = await bal();
    if (b > 0) {
      await sq("POST", "/gift-cards/activities", {
        idempotency_key: `${KEY}-drain`,
        gift_card_activity: {
          type: "ADJUST_DECREMENT",
          location_id: LOCATION,
          gift_card_id: giftCardId,
          adjust_decrement_activity_details: {
            amount_money: { amount: b, currency: "USD" },
            reason: "PURCHASE_WAS_REFUNDED",
          },
        },
      });
      console.log(`drained ${b}¢`);
    }
    console.log(`card ${giftCardId} left ACTIVE`);
  }
}

console.log("\n═══ FINDINGS ═══");
for (const f of findings) console.log(`• ${f}`);
