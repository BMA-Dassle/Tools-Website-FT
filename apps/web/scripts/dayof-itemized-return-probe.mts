/**
 * Can a refund be ITEMIZED against the original order's line items?
 *
 * Today every refund we issue is amount-only (POST /v2/refunds: payment_id +
 * amount_money + reason). Square therefore knows a dollar amount came back but
 * NOT which item it was for, so item-level sales reporting never sees the
 * refunded item and the QBO category mapping cannot attribute it.
 *
 * Q2 established that a PAID order's line_items are immutable. But Square's
 * Orders API models a return as a SEPARATE order carrying `returns[]` with
 * `source_order_id` + `return_line_items[].source_line_item_uid` — which does
 * not modify the original. Does that work for our shape, and can the refund be
 * attached to it?
 *
 * Probes, in order of preference:
 *   R1  Create a return order (returns[] referencing the paid order) and pay
 *       it with a NEGATIVE-equivalent refund — i.e. does CreateOrder accept
 *       our source order + line uid at all?
 *   R2  Does POST /v2/refunds accept a `line_items` / `app_fee` style
 *       itemization, or an order_id pointing at the return order?
 *   R3  Fallback reality check: what DOES the dashboard get from an
 *       amount-only refund (reason text only)?
 *
 * Non-accounting location, self-cleaning. DRY RUN by default:
 *   npx tsx scripts/dayof-itemized-return-probe.mts --live
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
const KEY = `itr-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: paid 2-line taxed order, then attempt an ITEMIZED return of one line");
  console.log("  R1 CreateOrder with returns[] + source_order_id + source_line_item_uid");
  console.log("  R2 POST /refunds attached to that return order");
  console.log("  R3 inspect what an amount-only refund actually records");
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
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 350)}`;
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
  // ── Setup: funded internal-shape card + paid taxed 2-line order ──────────
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
    },
  });
  if (!orderRes.ok) throw new Error(`order: ${errStr(orderRes)}`);
  const orderId = orderRes.json.order.id as string;
  const total = orderRes.json.order.total_money?.amount ?? 0;
  // Square may rewrite our uids — read back what it actually assigned.
  const liveL2 = orderRes.json.order.line_items.find((l: any) => l.name === "Pizza Bowl");
  const l2Uid = liveL2?.uid as string;
  const l2Total = liveL2?.total_money?.amount ?? ITEM;

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
  console.log(`order ${orderId} ${total}¢ paid; returning line ${l2Uid} (${l2Total}¢ + tax)`);

  // ── R1: a RETURN order referencing the paid order ────────────────────────
  const ret = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-ret`,
    order: {
      location_id: LOCATION,
      returns: [
        {
          source_order_id: orderId,
          return_line_items: [
            { source_line_item_uid: l2Uid, quantity: "1", uid: "R1" },
          ],
        },
      ],
    },
  });
  record(
    "R1 CreateOrder with returns[] referencing the paid order + source line uid",
    ret.ok
      ? `ACCEPTED — return order ${ret.json.order?.id}, ` +
          `return_amounts.total=${ret.json.order?.return_amounts?.total_money?.amount ?? "?"}¢, ` +
          `net_amount_due=${ret.json.order?.net_amount_due_money?.amount ?? "?"}¢. ` +
          `Square CAN model the refund at the item level.`
      : `REFUSED — ${errStr(ret)}`,
  );

  // ── R2: attach the refund to that return order ───────────────────────────
  const share = Math.round(ITEM * 1.07);
  if (ret.ok && ret.json.order?.id) {
    const withOrder = await sq("POST", "/refunds", {
      idempotency_key: `${KEY}-r1`,
      payment_id: paymentId,
      amount_money: { amount: share, currency: "USD" },
      order_id: ret.json.order.id,
      reason: "Probe: itemized return",
    });
    record(
      "R2 POST /refunds with order_id = the return order",
      withOrder.ok
        ? `ACCEPTED (refund ${withOrder.json.refund?.id}) — the refund is LINKED to the itemized return`
        : `REFUSED — ${errStr(withOrder)}`,
    );
  } else {
    record("R2 POST /refunds with order_id = the return order", "SKIPPED — R1 failed");
  }

  // ── R3: what does a plain amount-only refund actually carry? ─────────────
  const plain = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r2`,
    payment_id: paymentId,
    amount_money: { amount: 100, currency: "USD" },
    reason: "Probe: amount-only control",
  });
  if (plain.ok) {
    const rf = (await sq("GET", `/refunds/${plain.json.refund.id}`)).json?.refund;
    record(
      "R3 amount-only refund shape (today's behavior)",
      `keys=[${Object.keys(rf ?? {}).join(", ")}] — order_id=${rf?.order_id ?? "none"}. ` +
        `${rf?.order_id ? "Square links it to an order" : "No item attribution beyond the reason text"}`,
    );
  }
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
