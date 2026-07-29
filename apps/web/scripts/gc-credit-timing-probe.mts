/**
 * How long does a gift-card refund credit actually take to post — and does it
 * depend on the source order being CLOSED?
 *
 * The Tier-3 smoke parks every run at wait_gc_credit: the refund is accepted,
 * stays PENDING, and the money has not reached the card 2 minutes later. But
 * the 2026-07-27 gc-halfitems probe saw the credit within seconds. The one
 * structural difference is the order: that probe's order auto-COMPLETED on
 * payment, while a lane-open day-of order is deliberately held OPEN by a
 * fulfillment.
 *
 * Hypothesis: on an OPEN order the credit does not post until the order
 * closes. If true, the whole MID design has to change — the decrement cannot
 * be part of the same synchronous pass.
 *
 * Method: build the OPEN (fulfilled) shape, partial-refund it, and watch the
 * balance WITHOUT touching the card. If it has not landed, COMPLETE the order
 * and watch again.
 *
 * Non-accounting location, self-cleaning. DRY RUN by default:
 *   npx tsx scripts/gc-credit-timing-probe.mts --live
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
const KEY = `tim-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: OPEN (fulfilled) taxed order paid by a custom-GAN card");
  console.log("Would: partial refund, then poll the card balance for 3 min untouched");
  console.log("Would: if not landed, COMPLETE the order and poll another 3 min");
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
let paymentId: string | undefined;
let paidCents = 0;
const findings: string[] = [];

/** Poll the card + refund for `secs`, logging every 15s. Returns final state. */
async function watch(label: string, refundId: string, secs: number, want: number) {
  const t0 = Date.now();
  let bal = 0;
  let status = "?";
  while ((Date.now() - t0) / 1000 < secs) {
    bal = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.balance_money?.amount ?? 0;
    status = (await sq("GET", `/refunds/${refundId}`)).json?.refund?.status ?? "?";
    const el = Math.round((Date.now() - t0) / 1000);
    console.log(`  [${label}] t+${el}s balance=${bal}¢ refund=${status}`);
    if (bal >= want) {
      findings.push(`${label}: credit LANDED after ~${el}s (refund status was ${status})`);
      return { landed: true, secs: el, status };
    }
    await sleep(15000);
  }
  findings.push(`${label}: credit did NOT land within ${secs}s (balance ${bal}¢, refund ${status})`);
  return { landed: false, secs, status };
}

try {
  const gan = `WEBTIM${Date.now().toString().slice(-10)}`;
  const create = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan },
  });
  if (!create.ok) throw new Error(`card: ${errStr(create)}`);
  giftCardId = create.json.gift_card.id as string;

  const FUND = 3000;
  const co = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-co`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "eGiftCard (probe funding)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: FUND, currency: "USD" },
        },
      ],
      discounts: [
        { name: "Probe comp", amount_money: { amount: FUND, currency: "USD" }, scope: "ORDER" },
      ],
    },
  });
  if (!co.ok) throw new Error(`comp: ${errStr(co)}`);
  await sq("POST", `/orders/${co.json.order.id}/pay`, {
    idempotency_key: `${KEY}-cp`,
    payment_ids: [],
  });
  const act = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-act`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION,
      gift_card_id: giftCardId,
      activate_activity_details: {
        order_id: co.json.order.id,
        line_item_uid: co.json.order.line_items[0].uid,
      },
    },
  });
  if (!act.ok) throw new Error(`activate: ${errStr(act)}`);

  // OPEN (fulfilled) taxed order — the lane-open shape.
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
  paidCents = o.json.order.total_money?.amount ?? 0;

  const pay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-p`,
    source_id: giftCardId,
    amount_money: { amount: paidCents, currency: "USD" },
    order_id: orderId,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!pay.ok) throw new Error(`payment: ${errStr(pay)}`);
  paymentId = pay.json.payment.id as string;
  const st = (await sq("GET", `/orders/${orderId}`)).json?.order?.state;
  console.log(`order ${orderId} ${paidCents}¢ paid, state=${st}, card at 0¢`);

  // Itemized partial refund of the soda line.
  const ret = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-ret`,
    order: {
      location_id: LOCATION,
      returns: [
        { source_order_id: orderId, return_line_items: [{ uid: "R0", source_line_item_uid: "B", quantity: "1" }] },
      ],
    },
  });
  if (!ret.ok) throw new Error(`return order: ${errStr(ret)}`);
  const want = ret.json.order.return_amounts?.total_money?.amount ?? 0;
  const rf = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r1`,
    payment_id: paymentId,
    amount_money: { amount: want, currency: "USD" },
    order_id: ret.json.order.id,
    reason: "Probe: credit timing",
  });
  if (!rf.ok) throw new Error(`refund: ${errStr(rf)}`);
  const refundId = rf.json.refund.id as string;
  console.log(`\nrefunded ${want}¢ (itemized). Watching the card while the order stays OPEN…`);

  const openPhase = await watch("OPEN order", refundId, 180, want);

  if (!openPhase.landed) {
    console.log(`\nnot landed. Completing the order, then watching again…`);
    const fresh = await sq("GET", `/orders/${orderId}`);
    const done = await sq("PUT", `/orders/${orderId}`, {
      idempotency_key: `${KEY}-comp`,
      order: { location_id: LOCATION, version: fresh.json.order.version, state: "COMPLETED" },
    });
    console.log(`complete order → ${done.ok ? "ok" : errStr(done)}`);
    await watch("COMPLETED order", refundId, 180, want);
  }
} catch (e) {
  console.log(`\naborted: ${e instanceof Error ? e.message : e}`);
  findings.push(`ABORTED: ${e instanceof Error ? e.message : e}`);
} finally {
  console.log("\n— cleanup —");
  if (paymentId) {
    const p = (await sq("GET", `/payments/${paymentId}`)).json?.payment;
    const rest = paidCents - (p?.refunded_money?.amount ?? 0);
    if (rest > 0) {
      const r = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-rz`,
        payment_id: paymentId,
        amount_money: { amount: rest, currency: "USD" },
        reason: "Refund: Reservation Deposit",
      });
      console.log(`remainder ${rest}¢ → ${r.ok ? "ok" : errStr(r)}`);
    }
  }
  if (giftCardId) {
    // Give credits a last chance, then drain whatever is actually there.
    await sleep(20000);
    const bal =
      (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.balance_money?.amount ?? 0;
    console.log(`final card balance ${bal}¢`);
    if (bal > 0) {
      await sq("POST", "/gift-cards/activities", {
        idempotency_key: `${KEY}-drain`,
        gift_card_activity: {
          type: "ADJUST_DECREMENT",
          location_id: LOCATION,
          gift_card_id: giftCardId,
          adjust_decrement_activity_details: {
            amount_money: { amount: bal, currency: "USD" },
            reason: "PURCHASE_WAS_REFUNDED",
          },
        },
      });
      console.log(`drained ${bal}¢`);
    }
    console.log(
      `NOTE: card ${giftCardId} left ACTIVE at $0 on purpose — deactivating with credits in ` +
        `flight is what destroyed the 7/27 money.`,
    );
  }
}

console.log("\n═══ FINDINGS ═══");
for (const f of findings) console.log(`• ${f}`);
