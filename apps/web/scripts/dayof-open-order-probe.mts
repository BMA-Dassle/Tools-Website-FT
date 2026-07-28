/**
 * §9 follow-up: the OPEN-order half of the matrix.
 *
 * dayof-refund-matrix-probe answered Q1/Q3/Q4/Q5/Q6, but its order auto-closed
 * on payment, so the two questions that only matter for a MID-phase (lane
 * open, KDS ticket live) order went untested. Production keeps the day-of
 * order OPEN by attaching a FULFILLMENT — that is what holds the kitchen
 * ticket — so reproduce that shape here:
 *
 *   Q1-open  After a PARTIAL refund of the payment on an OPEN tendered order,
 *            does net_amount_due_money reopen? bowling-order-complete SKIPS
 *            any order with a balance due, so if it reopens, a crash between
 *            the refund and the line update strands the order forever
 *            (never closes, never reaches QuickBooks).
 *
 *   Q2       Does UpdateOrder (sparse PUT + fields_to_clear) work on an OPEN
 *            order that already has tenders, including dropping the total
 *            BELOW the tendered amount? Every MID money flow assumes yes.
 *
 * Also probes the ORDER of operations: lines-then-refund vs refund-then-lines,
 * since if the PUT is legal while overpaid we can eliminate the strand window
 * entirely by updating lines first.
 *
 * Non-accounting location only. Self-cleaning. DRY RUN by default:
 *   npx tsx scripts/dayof-open-order-probe.mts --live
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
const KEY = `oop-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: fund a custom-GAN card, build a TAXED 2-line order WITH a fulfillment");
  console.log("Would: pay it from the card and confirm it stays OPEN with tenders");
  console.log("Would: Q1-open — partial refund, then re-read net_amount_due");
  console.log("Would: Q2 — PUT fields_to_clear on that tendered OPEN order");
  console.log("Would: clean up (refund to zero, wait for credit, drain, deactivate)");
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
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 300)}`;
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
  // ── Fund a production-shape internal card ────────────────────────────────
  const gan = `WEBPRB${Date.now().toString().slice(-10)}`;
  const create = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan },
  });
  if (!create.ok) throw new Error(`card create: ${errStr(create)}`);
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
  const coPay = await sq("POST", `/orders/${co.json.order.id}/pay`, {
    idempotency_key: `${KEY}-cp`,
    payment_ids: [],
  });
  if (!coPay.ok) throw new Error(`comp pay: ${errStr(coPay)}`);
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
  console.log(`card ${giftCardId} gan=${gan} funded ${FUND}¢`);

  // ── Day-of shape: TAXED, two lines, WITH a fulfillment (holds it OPEN) ───
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
  if (!orderRes.ok) throw new Error(`day-of order: ${errStr(orderRes)}`);
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
  if (!pay.ok) throw new Error(`gc payment: ${errStr(pay)}`);
  paymentId = pay.json.payment.id as string;
  paidCents = total;

  const paid = await sq("GET", `/orders/${orderId}`);
  const stateAfterPay = paid.json?.order?.state;
  console.log(
    `order ${orderId} total=${total}¢ paid → state=${stateAfterPay} ` +
      `tenders=${paid.json?.order?.tenders?.length ?? 0} net_due=${paid.json?.order?.net_amount_due_money?.amount ?? 0}¢`,
  );
  if (stateAfterPay !== "OPEN") {
    record(
      "SETUP",
      `order is ${stateAfterPay}, not OPEN even with a fulfillment — the MID shape could not be ` +
        `reproduced; Q1-open/Q2 remain unanswered`,
    );
  }

  // ── Q2 FIRST (while fully paid): is a line PUT legal on a tendered order? ─
  const fresh = await sq("GET", `/orders/${orderId}`);
  const upd = await sq("PUT", `/orders/${orderId}`, {
    idempotency_key: `${KEY}-u1`,
    order: { location_id: LOCATION, version: fresh.json.order.version },
    fields_to_clear: ["line_items[L2]"],
  });
  record(
    "Q2 UpdateOrder + fields_to_clear on a TENDERED order (lines BEFORE refund)",
    upd.ok
      ? `ACCEPTED — total ${fresh.json.order.total_money?.amount}¢ → ${upd.json.order?.total_money?.amount}¢, ` +
          `state=${upd.json.order?.state}, net_due=${upd.json.order?.net_amount_due_money?.amount ?? 0}¢. ` +
          `Dropping the total BELOW the tendered amount is allowed, so lines-then-refund is a legal ` +
          `ordering and removes the strand window.`
      : `REFUSED — ${errStr(upd)} → lines must be updated AFTER the refund, keeping the strand window`,
  );

  // ── Q1-open: partial refund, then what happened to the order? ────────────
  const share = Math.round(ITEM * 1.07);
  const refund = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r1`,
    payment_id: paymentId,
    amount_money: { amount: share, currency: "USD" },
    reason: "Probe: day-of item removed",
  });
  if (!refund.ok) throw new Error(`partial refund: ${errStr(refund)}`);
  const after = await sq("GET", `/orders/${orderId}`);
  const due = after.json?.order?.net_amount_due_money?.amount ?? 0;
  record(
    "Q1-open order after a partial refund",
    `state=${after.json?.order?.state} total=${after.json?.order?.total_money?.amount}¢ ` +
      `net_amount_due=${due}¢ → ${
        due > 0
          ? "REOPENS a balance due — bowling-order-complete would skip this order forever; the " +
            "strand window is REAL and needs the resumable state + watchdog"
          : "does NOT reopen a balance due — no strand trap even on an OPEN order"
      }`,
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
      const de = await sq("POST", "/gift-cards/activities", {
        idempotency_key: `${KEY}-deact`,
        gift_card_activity: {
          type: "DEACTIVATE",
          location_id: LOCATION,
          gift_card_id: giftCardId,
          deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
        },
      });
      console.log(`deactivate → ${de.ok ? "ok" : errStr(de)}`);
    }
  }
}

console.log("\n═══ FINDINGS ═══");
for (const f of findings) console.log(`• ${f}`);
