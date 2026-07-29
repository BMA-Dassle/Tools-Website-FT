/**
 * Live probe of the owner's target refund flow (2026-07-27):
 *
 *   "Charging a day-of order removes gift card balance. Refunding anything
 *    from that day-of order should refund back to that gift card without any
 *    manual things done. Then we go back to the deposit transaction and
 *    refund only what was refunded back to the gift card."
 *
 * Scenario — refund HALF the items on the day-of order:
 *   1. Deposit: charge the owner's card on file $2, activate a $2 gift card.
 *   2. Day-of order: TWO $1 items, paid in full by the gift card (GC → $0).
 *   3. Refund $1 (= half the items) of the GC-funded day-of payment.
 *        Q1: does the $1 land back on the gift card AUTOMATICALLY?
 *   4. Refund $1 of the DEPOSIT card payment (only what came back to the GC).
 *        Q2: does Square auto-remove the matching $1 from the gift card
 *            (the deposit payment is what activated it), or does the surplus
 *            stay on the card needing an explicit ADJUST_DECREMENT?
 *   5. Cleanup to net zero: refund the remaining $1 of the day-of payment,
 *      refund the remaining $1 of the deposit payment, wait for credits,
 *      drain whatever the card still holds, deactivate.
 *
 * All refunds carry EXACTLY "Refund: Reservation Deposit" (portal journal
 * convention). Net: owner charged $2, refunded $2.
 *
 * DRY RUN by default. Run from apps/web:
 *   npx tsx scripts/gc-halfitems-probe.mts --live
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const LIVE = process.argv.includes("--live");
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
// Owner rule (2026-07-27): probes ALWAYS use this location — it does not
// track accounting. NEVER probe against a revenue location.
const LOCATION = "6MZJFTGAYD7TC";
const OWNER_EMAIL = "eric@headpinz.com";
const ITEM_CENTS = 100; // two $1 items
const TOTAL_CENTS = ITEM_CENTS * 2;
const REASON = "Refund: Reservation Deposit"; // owner convention — portal journal pickup
const KEY = `gchp-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Would: charge ${OWNER_EMAIL}'s card on file $2 → activate $2 gift card`);
  console.log("Would: day-of order with TWO $1 items, paid by the gift card");
  console.log("Would: refund $1 (half the items) of the day-of GC payment  ← Q1 auto-credit?");
  console.log("Would: refund $1 of the deposit card payment                ← Q2 auto-unload?");
  console.log("Would: cleanup — refund remainders, drain, deactivate. Net $0.");
  process.exit(0);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}
const errStr = (r: { status: number; json: any }): string =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 400)}`;

async function gcBalance(giftCardId: string): Promise<{ state?: string; bal: number }> {
  const gc = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
  return { state: gc?.state, bal: gc?.balance_money?.amount ?? 0 };
}

/** Poll the card until its balance reaches `target` (or ~2 min). */
async function waitForBalance(giftCardId: string, target: number): Promise<number> {
  let bal = 0;
  for (let i = 0; i < 24; i++) {
    bal = (await gcBalance(giftCardId)).bal;
    if (bal >= target) return bal;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return bal;
}

const verdicts: string[] = [];

const loc = await sq("GET", `/locations/${LOCATION}`);
if (!loc.ok) {
  console.log(`TOKEN CHECK FAILED: ${errStr(loc)}`);
  process.exit(2);
}
console.log(`token OK — ${loc.json.location?.name}`);

// ── 0. Card on file ──────────────────────────────────────────────────────────
const cust = await sq("POST", "/customers/search", {
  query: { filter: { email_address: { exact: OWNER_EMAIL } } },
  limit: 10,
});
let customerId: string | undefined;
let cardOnFile: { id: string; brand?: string; last4?: string } | undefined;
for (const c of cust.json?.customers ?? []) {
  const cards = await sq("GET", `/cards?customer_id=${c.id}`);
  const enabled = (cards.json?.cards ?? []).find((cd: any) => cd.enabled);
  if (enabled) {
    customerId = c.id;
    cardOnFile = { id: enabled.id, brand: enabled.card_brand, last4: enabled.last_4 };
    break;
  }
}
if (!customerId || !cardOnFile) {
  console.log(`No enabled card on file for ${OWNER_EMAIL} — aborting.`);
  process.exit(2);
}
console.log(`card on file: ${cardOnFile.brand} …${cardOnFile.last4}`);

let depositPaymentId: string | undefined;
let giftCardId: string | undefined;
let dayofPaymentId: string | undefined;

try {
  // ── 1. Deposit: $2 on the card, activate the gift card ────────────────────
  const buyOrder = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-bo`,
    order: {
      location_id: LOCATION,
      customer_id: customerId,
      line_items: [
        {
          name: "eGiftCard (deposit analog)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: TOTAL_CENTS, currency: "USD" },
        },
      ],
    },
  });
  if (!buyOrder.ok) throw new Error(`deposit order: ${errStr(buyOrder)}`);
  const buyOrderId = buyOrder.json.order.id;
  const buyLineUid = buyOrder.json.order.line_items[0].uid;

  const buyPay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-bp`,
    source_id: cardOnFile.id,
    customer_id: customerId,
    amount_money: { amount: TOTAL_CENTS, currency: "USD" },
    order_id: buyOrderId,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!buyPay.ok) throw new Error(`deposit charge: ${errStr(buyPay)}`);
  depositPaymentId = buyPay.json.payment.id;
  console.log(`deposit: charged ${TOTAL_CENTS}¢ — payment ${depositPaymentId}`);

  const create = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL" },
  });
  if (!create.ok) throw new Error(`gift card create: ${errStr(create)}`);
  giftCardId = create.json.gift_card.id as string;

  const act = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-act`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION,
      gift_card_id: giftCardId,
      activate_activity_details: { order_id: buyOrderId, line_item_uid: buyLineUid },
    },
  });
  if (!act.ok) throw new Error(`gift card activate: ${errStr(act)}`);
  console.log(`gift card ${giftCardId} ACTIVE @ ${TOTAL_CENTS}¢`);

  // ── 2. Day-of order: TWO $1 items, paid by the gift card ──────────────────
  const dayof = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-do`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "Day-of item A",
          quantity: "1",
          base_price_money: { amount: ITEM_CENTS, currency: "USD" },
        },
        {
          name: "Day-of item B",
          quantity: "1",
          base_price_money: { amount: ITEM_CENTS, currency: "USD" },
        },
      ],
    },
  });
  if (!dayof.ok) throw new Error(`day-of order: ${errStr(dayof)}`);
  const dayofOrderId = dayof.json.order.id;
  const dayofTotal = dayof.json.order.total_money?.amount ?? TOTAL_CENTS;

  const dayofPay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-dp`,
    source_id: giftCardId,
    amount_money: { amount: dayofTotal, currency: "USD" },
    order_id: dayofOrderId,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!dayofPay.ok) throw new Error(`day-of GC payment: ${errStr(dayofPay)}`);
  dayofPaymentId = dayofPay.json.payment.id;
  const afterCharge = await gcBalance(giftCardId);
  console.log(
    `day-of: order ${dayofOrderId} (2 × ${ITEM_CENTS}¢) paid by gift card — ` +
      `payment ${dayofPaymentId}; card balance now ${afterCharge.bal}¢`,
  );

  // ── 3. Q1 — refund HALF the items; does the GC get credited automatically?
  const half = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r1`,
    payment_id: dayofPaymentId,
    amount_money: { amount: ITEM_CENTS, currency: "USD" },
    reason: REASON,
  });
  if (!half.ok) throw new Error(`half-items refund: ${errStr(half)}`);
  console.log(`\nrefunded ${ITEM_CENTS}¢ (half the items) of the day-of payment — waiting for GC credit…`);
  const balAfterHalf = await waitForBalance(giftCardId, ITEM_CENTS);
  console.log(`gift card balance: ${balAfterHalf}¢`);
  verdicts.push(
    balAfterHalf >= ITEM_CENTS
      ? `Q1: YES — refunding half the day-of items credited the gift card automatically ` +
          `(balance ${balAfterHalf}¢, no manual steps).`
      : `Q1: NO/SLOW — ${ITEM_CENTS}¢ refund accepted but the card showed only ` +
          `${balAfterHalf}¢ after ~2 min. Check the card's REFUND activity before concluding.`,
  );

  // ── 4. Q2 — refund the SAME amount off the deposit card payment ───────────
  const dep = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r2`,
    payment_id: depositPaymentId,
    amount_money: { amount: ITEM_CENTS, currency: "USD" },
    reason: REASON,
  });
  if (!dep.ok) throw new Error(`deposit partial refund: ${errStr(dep)}`);
  console.log(
    `\nrefunded ${ITEM_CENTS}¢ of the deposit back to ${cardOnFile.brand} …${cardOnFile.last4} — ` +
      "watching whether Square auto-removes the matching value from the gift card…",
  );
  // Poll ~60s: if Square auto-unloads, the balance drops below balAfterHalf.
  let balAfterDep = balAfterHalf;
  for (let i = 0; i < 12; i++) {
    balAfterDep = (await gcBalance(giftCardId)).bal;
    if (balAfterDep < balAfterHalf) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`gift card balance: ${balAfterDep}¢`);
  verdicts.push(
    balAfterDep < balAfterHalf
      ? `Q2: YES — refunding the deposit payment auto-removed value from the gift card ` +
          `(${balAfterHalf}¢ → ${balAfterDep}¢). The whole chain is automatic.`
      : `Q2: NO — the deposit refund did NOT touch the gift card (still ${balAfterDep}¢). ` +
          `The surplus on the card must be removed explicitly (ADJUST_DECREMENT) or it's ` +
          `double value — the one non-automatic step in the chain.`,
  );
} catch (e) {
  console.log(`\nchain aborted: ${e instanceof Error ? e.message : e}`);
  verdicts.push(`CHAIN ABORTED: ${e instanceof Error ? e.message : e}`);
} finally {
  // ── 5. Cleanup to net zero ─────────────────────────────────────────────────
  console.log("\n— cleanup —");
  if (dayofPaymentId) {
    const p = await sq("GET", `/payments/${dayofPaymentId}`);
    const remaining =
      (p.json?.payment?.amount_money?.amount ?? 0) -
      (p.json?.payment?.refunded_money?.amount ?? 0);
    if (remaining > 0) {
      const r = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-r3`,
        payment_id: dayofPaymentId,
        amount_money: { amount: remaining, currency: "USD" },
        reason: REASON,
      });
      console.log(`day-of payment remainder (${remaining}¢) → ${r.ok ? "ok" : errStr(r)}`);
    }
  }
  if (depositPaymentId) {
    const p = await sq("GET", `/payments/${depositPaymentId}`);
    const remaining =
      (p.json?.payment?.amount_money?.amount ?? 0) -
      (p.json?.payment?.refunded_money?.amount ?? 0);
    if (remaining > 0) {
      const r = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-r4`,
        payment_id: depositPaymentId,
        amount_money: { amount: remaining, currency: "USD" },
        reason: REASON,
      });
      console.log(`deposit payment remainder (${remaining}¢) → ${r.ok ? "ok" : errStr(r)}`);
    }
  }
  if (giftCardId) {
    // Expect every cent refunded on the day-of payment to land back on the
    // card (minus anything Q2 auto-removed) — wait for credits to settle,
    // then drain what's actually there and deactivate.
    await new Promise((r) => setTimeout(r, 10000));
    let last = -1;
    for (let i = 0; i < 18; i++) {
      const { bal } = await gcBalance(giftCardId);
      if (bal === last) break; // stable two reads in a row
      last = bal;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const { state, bal } = await gcBalance(giftCardId);
    console.log(`gift card settled at ${bal}¢ (state ${state})`);
    if (state === "ACTIVE" && bal > 0) {
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
      console.log(`drained ${bal}¢ → ${d.ok ? "ok" : errStr(d)}`);
    }
    const settled = await gcBalance(giftCardId);
    if (settled.bal === 0) {
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
    } else {
      console.log(`card still holds ${settled.bal}¢ — left ACTIVE for manual review`);
    }
  }
}

console.log("\n═══ VERDICTS ═══");
for (const v of verdicts) console.log(`• ${v}`);
