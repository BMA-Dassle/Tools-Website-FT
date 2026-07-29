/**
 * Owner's question (2026-07-28): does an ITEMIZED refund need to be TOLD the
 * gift card as its destination?
 *
 * A linked refund normally infers the destination from payment_id. But when
 * order_id points at a RETURN order — a different order from the one the
 * payment settled — the tender linkage may be ambiguous, which would explain
 * the missing credit. Square exposes destination_id on the refund.
 *
 * If passing destination_id = <gift card id> alongside payment_id + order_id
 * credits the card, BOTH requirements are satisfied at once: item-level
 * attribution AND the money landing where the rest of the chain needs it.
 *
 * Three arms, same card, clean 0 baseline after payment, one line returned
 * each time so the amounts are identical and comparable:
 *   A  payment_id + order_id + destination_id   ← the owner's proposal
 *   B  payment_id + order_id                    (control: known not to credit fast)
 *   C  payment_id only                          (control: known to credit in ~10s)
 *
 * Each arm is watched for 150s against a REAL baseline (an earlier probe gave
 * a false positive by assuming 0). Non-accounting location; card left ACTIVE.
 *
 *   npx tsx scripts/gc-itemized-destination-probe.mts --live
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
const KEY = `dst-${randomUUID().slice(0, 8)}`;
const LINE = 600;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: one GC-paid order with 3 identical returnable lines, then");
  console.log("  A refund payment_id+order_id+destination_id  ← owner's proposal");
  console.log("  B refund payment_id+order_id                 (control)");
  console.log("  C refund payment_id only                     (control)");
  console.log("Would: watch the card 150s per arm against a real baseline");
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
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 220)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let giftCardId: string | undefined;
const bal = async () =>
  (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.balance_money?.amount ?? 0;
const findings: string[] = [];

/** Watch for the balance to exceed `from`; returns the observed end balance. */
async function watch(label: string, from: number, secs: number) {
  const t0 = Date.now();
  for (;;) {
    const b = await bal();
    const el = Math.round((Date.now() - t0) / 1000);
    if (b > from) {
      console.log(`  [${label}] CREDITED at t+${el}s: ${from}¢ → ${b}¢`);
      return b;
    }
    if ((Date.now() - t0) / 1000 >= secs) {
      console.log(`  [${label}] no credit after ${el}s (still ${b}¢)`);
      return b;
    }
    await sleep(10000);
  }
}

try {
  const gan = `WEBDST${Date.now().toString().slice(-10)}`;
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
        { uid: "KEEP", name: "Lane time", quantity: "1", base_price_money: { amount: 1500, currency: "USD" } },
        { uid: "A", name: "Item A", quantity: "1", base_price_money: { amount: LINE, currency: "USD" } },
        { uid: "B", name: "Item B", quantity: "1", base_price_money: { amount: LINE, currency: "USD" } },
        { uid: "C", name: "Item C", quantity: "1", base_price_money: { amount: LINE, currency: "USD" } },
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
  let cur = await bal();
  console.log(`order ${total}¢ paid from the card. TRUE baseline = ${cur}¢\n`);

  const mkReturn = async (uid: string, tag: string) => {
    const r = await sq("POST", "/orders", {
      idempotency_key: `${KEY}-ret${tag}`,
      order: {
        location_id: LOCATION,
        returns: [
          { source_order_id: orderId, return_line_items: [{ uid: `R${tag}`, source_line_item_uid: uid, quantity: "1" }] },
        ],
      },
    });
    if (!r.ok) throw new Error(`return ${tag}: ${errStr(r)}`);
    return { id: r.json.order.id as string, amt: r.json.order.return_amounts?.total_money?.amount ?? 0 };
  };

  // ── A. itemized + destination_id (the owner's proposal) ──────────────────
  const retA = await mkReturn("A", "A");
  const rA = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-rA`,
    payment_id: paymentId,
    amount_money: { amount: retA.amt, currency: "USD" },
    order_id: retA.id,
    destination_id: giftCardId,
    reason: "Probe A: itemized + destination",
  });
  console.log(`A. itemized + destination_id → ${rA.ok ? "accepted" : errStr(rA)}`);
  if (rA.ok) {
    const after = await watch("A", cur, 150);
    findings.push(
      after > cur
        ? `A ITEMIZED + destination_id: CREDITED the card (+${after - cur}¢) — satisfies BOTH requirements`
        : `A ITEMIZED + destination_id: no credit within 150s`,
    );
    cur = after;
  } else {
    findings.push(`A ITEMIZED + destination_id: REJECTED — ${errStr(rA)}`);
  }

  // ── B. itemized, no destination (control) ────────────────────────────────
  const retB = await mkReturn("B", "B");
  const rB = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-rB`,
    payment_id: paymentId,
    amount_money: { amount: retB.amt, currency: "USD" },
    order_id: retB.id,
    reason: "Probe B: itemized only",
  });
  console.log(`\nB. itemized only → ${rB.ok ? "accepted" : errStr(rB)}`);
  if (rB.ok) {
    const after = await watch("B", cur, 150);
    findings.push(
      after > cur ? `B ITEMIZED only: CREDITED (+${after - cur}¢)` : `B ITEMIZED only: no credit within 150s`,
    );
    cur = after;
  }

  // ── C. plain (control) ───────────────────────────────────────────────────
  const rC = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-rC`,
    payment_id: paymentId,
    amount_money: { amount: retB.amt, currency: "USD" },
    reason: "Probe C: plain",
  });
  console.log(`\nC. plain → ${rC.ok ? "accepted" : errStr(rC)}`);
  if (rC.ok) {
    const after = await watch("C", cur, 150);
    findings.push(
      after > cur ? `C PLAIN: CREDITED (+${after - cur}¢)` : `C PLAIN: no credit within 150s`,
    );
    cur = after;
  }
} catch (e) {
  console.log(`\naborted: ${e instanceof Error ? e.message : e}`);
  findings.push(`ABORTED: ${e instanceof Error ? e.message : e}`);
} finally {
  if (giftCardId) {
    await sleep(10000);
    const b = await bal();
    console.log(`\nfinal card balance ${b}¢`);
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
