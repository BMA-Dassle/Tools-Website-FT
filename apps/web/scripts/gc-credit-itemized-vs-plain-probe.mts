/**
 * DECISIVE: does an ITEMIZED refund (order_id = a return order) credit the
 * gift card the same way a plain refund does?
 *
 * The Tier-3 smoke kept parking at wait_gc_credit, and the timing probe's
 * cleanup arithmetic suggested the itemized refund's money never reached the
 * card while a plain refund against the SAME payment did. If that is real, the
 * owner's never-amount-only rule and the design's credit-then-decrement chain
 * are in direct conflict and the flow needs rethinking.
 *
 * Method: one funded card, one GC-paid order, two refunds of the SAME amount
 * against the SAME payment — first itemized (order_id = return order), then
 * plain — reading the card balance before and after each with a REAL baseline
 * (the previous probe's bug was assuming a 0 baseline).
 *
 * Non-accounting location. Card is left ACTIVE at the end (never deactivate
 * with credits in flight). DRY RUN by default:
 *   npx tsx scripts/gc-credit-itemized-vs-plain-probe.mts --live
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
const KEY = `ivp-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: fund a card EXACTLY to the order total (baseline 0 after payment)");
  console.log("Would: refund line B itemized (order_id=return) → measure the balance delta");
  console.log("Would: refund the same amount PLAIN → measure the balance delta");
  console.log("Would: compare — does itemization suppress the gift-card credit?");
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

/** Poll for up to `secs` for the balance to rise above `from`. */
async function waitRise(from: number, secs: number, label: string) {
  const t0 = Date.now();
  for (;;) {
    const b = await bal();
    const el = Math.round((Date.now() - t0) / 1000);
    if (b > from) {
      console.log(`  [${label}] t+${el}s balance ${from}¢ → ${b}¢ (+${b - from})`);
      return b;
    }
    if ((Date.now() - t0) / 1000 >= secs) {
      console.log(`  [${label}] t+${el}s balance still ${b}¢ — NO credit`);
      return b;
    }
    await sleep(10000);
  }
}

const findings: string[] = [];

try {
  const gan = `WEBIVP${Date.now().toString().slice(-10)}`;
  const create = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan },
  });
  if (!create.ok) throw new Error(`card: ${errStr(create)}`);
  giftCardId = create.json.gift_card.id as string;

  // Build the order FIRST so the card can be funded to its exact total —
  // that way the post-payment baseline is a clean 0.
  const o = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-o`,
    order: {
      location_id: LOCATION,
      line_items: [
        { uid: "A", name: "Lane time", quantity: "1", base_price_money: { amount: 1500, currency: "USD" } },
        { uid: "B", name: "Soda", quantity: "1", base_price_money: { amount: 600, currency: "USD" } },
        { uid: "C", name: "Chips", quantity: "1", base_price_money: { amount: 600, currency: "USD" } },
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
        {
          name: "eGiftCard (probe funding)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: total, currency: "USD" },
        },
      ],
      discounts: [{ name: "Probe comp", amount_money: { amount: total, currency: "USD" }, scope: "ORDER" }],
    },
  });
  if (!co.ok) throw new Error(`comp: ${errStr(co)}`);
  await sq("POST", `/orders/${co.json.order.id}/pay`, { idempotency_key: `${KEY}-cp`, payment_ids: [] });
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
  const base0 = await bal();
  console.log(`order ${orderId} total ${total}¢ paid from the card. TRUE baseline = ${base0}¢`);

  // ── A. ITEMIZED refund of line B ─────────────────────────────────────────
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
  const amt = ret.json.order.return_amounts?.total_money?.amount ?? 0;
  const rfItem = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r1`,
    payment_id: paymentId,
    amount_money: { amount: amt, currency: "USD" },
    order_id: ret.json.order.id,
    reason: "Probe: itemized",
  });
  if (!rfItem.ok) throw new Error(`itemized refund: ${errStr(rfItem)}`);
  console.log(`\nA. ITEMIZED refund ${amt}¢ (return order ${ret.json.order.id})`);
  const afterItem = await waitRise(base0, 120, "itemized");
  findings.push(
    afterItem > base0
      ? `ITEMIZED refund DID credit the card (+${afterItem - base0}¢ of ${amt}¢)`
      : `ITEMIZED refund did NOT credit the card within 120s (still ${afterItem}¢)`,
  );

  // ── B. PLAIN refund of the same amount ───────────────────────────────────
  const rfPlain = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r2`,
    payment_id: paymentId,
    amount_money: { amount: amt, currency: "USD" },
    reason: "Probe: plain",
  });
  if (!rfPlain.ok) throw new Error(`plain refund: ${errStr(rfPlain)}`);
  console.log(`\nB. PLAIN refund ${amt}¢ (no order_id)`);
  const afterPlain = await waitRise(afterItem, 120, "plain");
  findings.push(
    afterPlain > afterItem
      ? `PLAIN refund DID credit the card (+${afterPlain - afterItem}¢ of ${amt}¢)`
      : `PLAIN refund did NOT credit the card within 120s (still ${afterPlain}¢)`,
  );

  const p = (await sq("GET", `/payments/${paymentId}`)).json?.payment;
  findings.push(
    `payment refunded_money=${p?.refunded_money?.amount ?? 0}¢ of ${total}¢ — card holds ${afterPlain}¢`,
  );
} catch (e) {
  console.log(`\naborted: ${e instanceof Error ? e.message : e}`);
  findings.push(`ABORTED: ${e instanceof Error ? e.message : e}`);
} finally {
  if (giftCardId) {
    await sleep(15000);
    const b = await bal();
    console.log(`\nfinal balance ${b}¢`);
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
    console.log(`card ${giftCardId} left ACTIVE (never deactivate with credits in flight)`);
  }
}

console.log("\n═══ FINDINGS ═══");
for (const f of findings) console.log(`• ${f}`);
