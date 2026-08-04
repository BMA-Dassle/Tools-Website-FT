/**
 * The owner's original ask, in the shape that actually works.
 *
 * Proven 2026-07-28: a CROSS-TENDER **linked** refund (payment_id present,
 * `destination_id` pointing somewhere other than the original tender) DOES move
 * money — a gift-card destination credited in ~10s and the refund COMPLETED.
 * Every UNLINKED shape stays declined. So "refund to gift card or credit card"
 * is a cross-tender refund, not an unlinked one.
 *
 * This arm finishes the matrix: cross-tender refund of a gift-card-funded soda
 * payment, destination = the owner's VISA …5214 card on file. That is the leg
 * that has failed every previous attempt — but always as an UNLINKED refund.
 * If it completes here, the card was never the problem; `unlinked: true` was.
 *
 *   X1  payment_id + destination_id = ccof card          (no customer_id)
 *   X2  retry with customer_id if X1 says it's required
 *
 * NOT itemized on purpose: `order_id` is what kills the credit (reproduced
 * cross-tender in the T2 arm — accepted, PENDING forever, never credited). So
 * this arm answers "does the money move", and the never-amount-only conflict is
 * called out in the findings rather than papered over.
 *
 * Money: one soda (426¢) genuinely lands on the owner's card. Owner-authorized.
 * Funding side is a comped gift card, so nothing is charged to anyone first.
 *
 * Run from apps/web:
 *   npx tsx scripts/crosstender-refund-to-card-probe.mts          # dry run
 *   npx tsx scripts/crosstender-refund-to-card-probe.mts --live
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
const CUSTOMER_ID = "ABRRYRM2HH2BNFBK2FQ16V2ZDG";
const SODA_VARIATION_ID = "NTLI7WKX6QVXCOZNA4YC3GZ7";
const TAX_ID = "UBPQTR3W6ZKVRYFC7DXN2SJN";
const REASON = "Refund: Reservation Deposit";
const KEY = `xcrd-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: comp-fund a gift card, buy one soda with it (426¢),");
  console.log("       then cross-tender refund that payment to VISA …5214 on file.");
  console.log("One soda lands on the owner's real card. Nothing is charged first.");
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
const codes = (r: { json: any }) =>
  (r.json?.errors ?? []).map((e: any) => `${e.category}/${e.code}`).join(",") || "-";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fundingCard: string | undefined;

try {
  const cards = await sq("GET", `/cards?customer_id=${CUSTOMER_ID}`);
  const card = (cards.json?.cards ?? []).find((c: any) => c.enabled);
  if (!card) throw new Error(`no enabled card on file: ${errStr(cards)}`);
  console.log(`destination: ${card.card_brand} …${card.last_4} ${card.card_type} (${card.id})`);

  // ── funding: comped gift card buys one soda ──────────────────────────────
  const gc = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL" },
  });
  if (!gc.ok) throw new Error(`gift card: ${errStr(gc)}`);
  fundingCard = gc.json.gift_card.id as string;
  const FUND = 1000;
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
      gift_card_id: fundingCard,
      activate_activity_details: {
        order_id: co.json.order.id,
        line_item_uid: co.json.order.line_items[0].uid,
      },
    },
  });
  if (!act.ok) throw new Error(`activate: ${errStr(act)}`);

  const o = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-so`,
    order: {
      location_id: LOCATION,
      line_items: [{ uid: "SODA", catalog_object_id: SODA_VARIATION_ID, quantity: "1" }],
      taxes: [{ uid: "TX", catalog_object_id: TAX_ID, scope: "ORDER" }],
    },
  });
  if (!o.ok) throw new Error(`soda order: ${errStr(o)}`);
  const total = o.json.order.total_money.amount as number;
  const pay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-sp`,
    source_id: fundingCard,
    amount_money: { amount: total, currency: "USD" },
    order_id: o.json.order.id,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!pay.ok) throw new Error(`soda payment: ${errStr(pay)}`);
  console.log(`soda order ${o.json.order.id} ${total}¢ paid by gift card (payment ${pay.json.payment.id})`);

  // ── X1 / X2: cross-tender refund → the owner's card ─────────────────────
  // A LINKED refund must NOT carry location_id (CONFLICTING_PARAMETERS).
  let r = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-x1`,
    payment_id: pay.json.payment.id,
    amount_money: { amount: total, currency: "USD" },
    destination_id: card.id,
    reason: REASON,
  });
  let shape = "no customer_id";
  if (!r.ok) {
    console.log(`\nX1 (${shape}) → ${codes(r)} — ${errStr(r)}`);
    console.log("retrying with customer_id…");
    r = await sq("POST", "/refunds", {
      idempotency_key: `${KEY}-x2`,
      payment_id: pay.json.payment.id,
      amount_money: { amount: total, currency: "USD" },
      destination_id: card.id,
      customer_id: CUSTOMER_ID,
      reason: REASON,
    });
    shape = "with customer_id";
  }

  if (!r.ok) {
    console.log(
      `\n>>> CROSS-TENDER refund → VISA …${card.last_4}: REFUSED (${shape}) — ` +
        `${codes(r)} — ${errStr(r)}`,
    );
    console.log(
      "    A gift-card destination completed on this same shape, so a card-only failure here " +
        "means the card rail is genuinely the blocker for card destinations — worth the rep's time.",
    );
  } else {
    const id = r.json.refund.id;
    console.log(`\n>>> CROSS-TENDER refund ACCEPTED (${shape}) — ${id}`);
    let st = r.json.refund.status;
    for (let i = 0; i < 12 && !["COMPLETED", "FAILED", "REJECTED"].includes(st); i++) {
      await sleep(10_000);
      const g = await sq("GET", `/refunds/${id}`);
      st = g.json?.refund?.status ?? "?";
      console.log(`    +${(i + 1) * 10}s status=${st}`);
    }
    console.log(
      st === "COMPLETED"
        ? `\n    COMPLETED — ${total}¢ is on VISA …${card.last_4}. The card was NEVER the problem: ` +
            `\`unlinked: true\` was. Cross-tender refunds reach both gift cards AND credit cards.`
        : `\n    ${st} — accepted but did not complete. Re-check: GET /v2/refunds/${id}`,
    );
  }
} catch (e) {
  console.error(`\nFATAL: ${(e as Error).message}`);
} finally {
  if (fundingCard) {
    const c = await sq("GET", `/gift-cards/${fundingCard}`);
    const bal = c.json?.gift_card?.balance_money?.amount ?? 0;
    if (bal > 0) {
      const d = await sq("POST", "/gift-cards/activities", {
        idempotency_key: `${KEY}-drain`,
        gift_card_activity: {
          type: "ADJUST_DECREMENT",
          location_id: LOCATION,
          gift_card_id: fundingCard,
          adjust_decrement_activity_details: {
            amount_money: { amount: bal, currency: "USD" },
            reason: "PURCHASE_WAS_REFUNDED",
          },
        },
      });
      console.log(`\ncleanup: drained funding card ${bal}¢ → ${d.ok ? "0¢" : errStr(d)}`);
    } else {
      console.log(`\ncleanup: funding card already 0¢`);
    }
  }
}
