/**
 * Decisive follow-up to Q2.
 *
 * dayof-open-order-probe showed Square REFUSES a line PUT on a fully-paid
 * order: "LineItems cannot be modified for finalized tenders." But it tried
 * the PUT BEFORE refunding, and the MID plan's real ordering is
 * refund-then-lines. So: does partially refunding the tender unlock the line
 * update?
 *
 * If NO, the MID phase's `update_dayof_order` step can never succeed on a
 * lane-open (tendered) order, and the money-only shape is the ONLY valid
 * post-payment refund shape — the order keeps its lines and the refund
 * objects tell the story.
 *
 * Non-accounting location, self-cleaning. DRY RUN by default:
 *   npx tsx scripts/dayof-lines-after-refund-probe.mts --live
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
const ITEM = 1000;
const KEY = `lar-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: paid OPEN order (fulfillment) → PARTIAL refund → THEN attempt the line PUT");
  console.log("Would: also attempt a FULL refund → line PUT, to see if zero tenders unlocks it");
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

const findings: string[] = [];
const record = (q: string, a: string) => {
  findings.push(`${q}: ${a}`);
  console.log(`\n>>> ${q}: ${a}`);
};

let giftCardId: string | undefined;
let paymentId: string | undefined;
let paidCents = 0;

try {
  const gan = `WEBPRB${Date.now().toString().slice(-10)}`;
  const create = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan },
  });
  if (!create.ok) throw new Error(`card: ${errStr(create)}`);
  giftCardId = create.json.gift_card.id as string;

  const FUND = ITEM * 3;
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
  if (!co.ok) throw new Error(`comp order: ${errStr(co)}`);
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

  const orderRes = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-o`,
    order: {
      location_id: LOCATION,
      line_items: [
        { uid: "L1", name: "Lane time", quantity: "1", base_price_money: { amount: ITEM, currency: "USD" } },
        { uid: "L2", name: "Pizza Bowl", quantity: "1", base_price_money: { amount: ITEM, currency: "USD" } },
      ],
      taxes: [{ uid: "TX", name: "Probe tax", percentage: "7", scope: "ORDER" }],
      fulfillments: [
        { type: "PICKUP", state: "PROPOSED", pickup_details: { recipient: { display_name: "Probe" }, schedule_type: "ASAP" } },
      ],
    },
  });
  if (!orderRes.ok) throw new Error(`order: ${errStr(orderRes)}`);
  const orderId = orderRes.json.order.id as string;
  const total = orderRes.json.order.total_money?.amount ?? 0;

  const pay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-p`,
    source_id: giftCardId,
    amount_money: { amount: total, currency: "USD" },
    order_id: orderId,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!pay.ok) throw new Error(`payment: ${errStr(pay)}`);
  paymentId = pay.json.payment.id as string;
  paidCents = total;
  console.log(`order ${orderId} ${total}¢ paid, state=OPEN`);

  // ── PARTIAL refund, then the line PUT ─────────────────────────────────────
  const share = Math.round(ITEM * 1.07);
  const r1 = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r1`,
    payment_id: paymentId,
    amount_money: { amount: share, currency: "USD" },
    reason: "Probe: day-of item removed",
  });
  if (!r1.ok) throw new Error(`partial refund: ${errStr(r1)}`);
  await sleep(3000);
  let fresh = await sq("GET", `/orders/${orderId}`);
  const putAfterPartial = await sq("PUT", `/orders/${orderId}`, {
    idempotency_key: `${KEY}-u1`,
    order: { location_id: LOCATION, version: fresh.json.order.version },
    fields_to_clear: ["line_items[L2]"],
  });
  record(
    "Line PUT AFTER a PARTIAL refund",
    putAfterPartial.ok
      ? `ACCEPTED — total now ${putAfterPartial.json.order?.total_money?.amount}¢. The MID plan's ` +
          `refund-then-lines ordering WORKS.`
      : `REFUSED — ${errStr(putAfterPartial)}`,
  );

  // ── FULL refund (zero net tender), then the line PUT ─────────────────────
  const p = await sq("GET", `/payments/${paymentId}`);
  const rest = paidCents - (p.json?.payment?.refunded_money?.amount ?? 0);
  if (rest > 0) {
    const r2 = await sq("POST", "/refunds", {
      idempotency_key: `${KEY}-r2`,
      payment_id: paymentId,
      amount_money: { amount: rest, currency: "USD" },
      reason: "Refund: Reservation Deposit",
    });
    if (!r2.ok) throw new Error(`full refund: ${errStr(r2)}`);
  }
  await sleep(3000);
  fresh = await sq("GET", `/orders/${orderId}`);
  const putAfterFull = await sq("PUT", `/orders/${orderId}`, {
    idempotency_key: `${KEY}-u2`,
    order: { location_id: LOCATION, version: fresh.json.order.version },
    fields_to_clear: ["line_items[L2]"],
  });
  record(
    "Line PUT after a FULL refund (tender fully reversed)",
    putAfterFull.ok
      ? `ACCEPTED — even a finalized tender stops blocking once fully refunded`
      : `REFUSED — ${errStr(putAfterFull)} → a tendered order's lines are immutable, period`,
  );
  const end = await sq("GET", `/orders/${orderId}`);
  console.log(
    `final order state=${end.json?.order?.state} total=${end.json?.order?.total_money?.amount}¢ ` +
      `net_due=${end.json?.order?.net_amount_due_money?.amount ?? 0}¢`,
  );
} catch (e) {
  console.log(`\naborted: ${e instanceof Error ? e.message : e}`);
  findings.push(`ABORTED: ${e instanceof Error ? e.message : e}`);
} finally {
  console.log("\n— cleanup —");
  if (paymentId) {
    const p = await sq("GET", `/payments/${paymentId}`);
    const remaining = paidCents - (p.json?.payment?.refunded_money?.amount ?? 0);
    if (remaining > 0) {
      const r = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-rz`,
        payment_id: paymentId,
        amount_money: { amount: remaining, currency: "USD" },
        reason: "Refund: Reservation Deposit",
      });
      console.log(`remainder ${remaining}¢ → ${r.ok ? "ok" : errStr(r)}`);
    }
  }
  if (giftCardId) {
    let bal = 0;
    let last = -1;
    for (let i = 0; i < 24; i++) {
      bal = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.balance_money?.amount ?? 0;
      if (bal === last && bal > 0) break;
      last = bal;
      await sleep(5000);
    }
    console.log(`card settled at ${bal}¢`);
    if (bal > 0) {
      const d = await sq("POST", "/gift-cards/activities", {
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
      console.log(`drain → ${d.ok ? "ok" : errStr(d)}`);
    }
    const st = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
    if (st?.state === "ACTIVE" && (st?.balance_money?.amount ?? 0) === 0) {
      await sq("POST", "/gift-cards/activities", {
        idempotency_key: `${KEY}-deact`,
        gift_card_activity: {
          type: "DEACTIVATE",
          location_id: LOCATION,
          gift_card_id: giftCardId,
          deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
        },
      });
      console.log("deactivate → ok");
    }
  }
}

console.log("\n═══ FINDINGS ═══");
for (const f of findings) console.log(`• ${f}`);
