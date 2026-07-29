/**
 * Live probe of the FULL gift-card refund chain, owner-authorized 2026-07-27
 * ("buy a gift card with my card on file to truly test this").
 *
 * Chain under test (mirrors production deposits exactly):
 *   credit card → buys gift card → gift card pays an order → refunds walk back
 *
 *  PROBE A — Can a GIFT-CARD-FUNDED payment be PARTIALLY refunded via the API?
 *    tasks/lessons.md (2026-07-11) records "NO" as an owner live finding, but
 *    HOW it was tried (dashboard vs API) was never recorded. If the API allows
 *    it, the RESERVATION_EDIT_V2_MID_DECREASE / _POST designs are viable
 *    without redesign.
 *
 *  PROBE C — Full refund of the gift-card PURCHASE back to the credit card
 *    (the "gift card back to credit card" leg — also the make-whole step).
 *
 *  PROBE B — Is UNLINKED REFUND processing enabled on our account yet?
 *    (Square rep Kaitlin Kendall was "still working on it" as of 2026-07-24.)
 *    Destination = the owner's card on file. If enabled, $1.00 lands on it.
 *
 * Sequence (live production account, HeadPinz Fort Myers):
 *   0. Find the owner's Square customer + enabled card on file.
 *   1. Order with a $2 GIFT_CARD line, PAID by the card on file (real charge).
 *   2. Create DIGITAL gift card + ACTIVATE against that order/line → $2 card.
 *   3. $2 ad-hoc order, PAID by the gift card (source_id = gift card id).
 *   4. $1 PARTIAL refund of that GC-funded payment          ← PROBE A
 *   5. Refund the GC payment's remainder (full-remainder is legal) — the $2
 *      returns to the gift card either way.
 *   6. Drain (ADJUST_DECREMENT) + DEACTIVATE the gift card. Zero value left.
 *   7. FULL refund of the step-1 purchase payment → owner's credit card
 *                                                            ← PROBE C
 *   8. $1 UNLINKED refund to the card on file               ← PROBE B
 *
 * Net money: owner charged $2 (step 1), refunded $2 (step 7); +$1 if PROBE B
 * finds the entitlement enabled. Cleanup runs in a finally block, so a
 * mid-flow crash still drains the card and refunds the purchase.
 *
 * DRY RUN by default (prints the plan). Pass --live to execute.
 * Run from apps/web:  npx tsx scripts/gc-refund-probe.mts --live
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
const FUND_CENTS = 200; // $2.00 gift card
const PARTIAL_CENTS = 100; // $1.00 partial-refund ask
const UNLINKED_CENTS = 100; // $1.00 unlinked refund
const KEY = `gcrp-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Would: find ${OWNER_EMAIL}'s card on file`);
  console.log(`Would: charge it $2 for a GIFT_CARD-line order @ ${LOCATION}`);
  console.log("Would: create + ACTIVATE a $2 gift card against that order");
  console.log("Would: create $2 ad-hoc order, pay with the gift card");
  console.log("Would: attempt $1 PARTIAL refund of the GC-funded payment  ← PROBE A");
  console.log("Would: refund the GC payment remainder; drain + deactivate the card");
  console.log("Would: FULLY refund the $2 purchase back to the credit card ← PROBE C");
  console.log("Would: attempt $1 UNLINKED refund to the card on file       ← PROBE B");
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
  const ok = res.ok && !(json?.errors?.length > 0);
  return { ok, status: res.status, json };
}

const errStr = (r: { status: number; json: any }): string =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 400)}`;
const codesOf = (r: { json: any }): string =>
  (r.json?.errors ?? []).map((e: any) => `${e.category}/${e.code}`).join(", ") || "(none)";

const verdicts: string[] = [];

// ── Token sanity (read-only) ─────────────────────────────────────────────────
const loc = await sq("GET", `/locations/${LOCATION}`);
if (!loc.ok) {
  console.log(`TOKEN CHECK FAILED: ${errStr(loc)}`);
  process.exit(2);
}
console.log(`token OK — ${loc.json.location?.name}`);

// ── 0. Owner's customer + card on file ──────────────────────────────────────
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
  console.log(`No enabled card on file found for ${OWNER_EMAIL} — cannot run. Aborting.`);
  process.exit(2);
}
console.log(`card on file: ${cardOnFile.brand} …${cardOnFile.last4} (customer ${customerId})`);

let purchasePaymentId: string | undefined; // step 1 — refunded in step 7 (make-whole)
let purchaseCents = 0;
let giftCardId: string | undefined; // step 2 — drained + deactivated in step 6
let gcPaymentId: string | undefined; // step 3 — zeroed in steps 4+5
let gcPaymentCents = 0;

try {
  // ── 1. Buy the gift card with the card on file (REAL charge) ──────────────
  const buyOrder = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-bo`,
    order: {
      location_id: LOCATION,
      customer_id: customerId,
      line_items: [
        {
          name: "eGiftCard (refund-chain probe)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: FUND_CENTS, currency: "USD" },
        },
      ],
    },
  });
  if (!buyOrder.ok) throw new Error(`purchase order: ${errStr(buyOrder)}`);
  const buyOrderId = buyOrder.json.order.id;
  const buyLineUid = buyOrder.json.order.line_items[0].uid;
  purchaseCents = buyOrder.json.order.total_money?.amount ?? FUND_CENTS;

  const buyPay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-bp`,
    source_id: cardOnFile.id,
    customer_id: customerId,
    amount_money: { amount: purchaseCents, currency: "USD" },
    order_id: buyOrderId,
    location_id: LOCATION,
    autocomplete: true,
    note: "probe: gift card purchase (will be fully refunded)",
  });
  if (!buyPay.ok) throw new Error(`card-on-file charge: ${errStr(buyPay)}`);
  purchasePaymentId = buyPay.json.payment.id;
  console.log(
    `charged ${cardOnFile.brand} …${cardOnFile.last4} ${purchaseCents}¢ — payment ${purchasePaymentId}`,
  );

  // ── 2. Create + ACTIVATE the gift card against the paid order ─────────────
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
  const gcBal = act.json.gift_card_activity?.gift_card_balance_money?.amount ?? 0;
  if (gcBal !== FUND_CENTS) throw new Error(`gift card activated at ${gcBal}¢, expected ${FUND_CENTS}¢`);
  console.log(`gift card ${giftCardId} ACTIVE @ ${gcBal}¢ (card-funded, real purchase)`);

  // ── 3. Spend the gift card on a $2 order ──────────────────────────────────
  const spendOrder = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-so`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "Refund probe item (will be fully refunded)",
          quantity: "1",
          base_price_money: { amount: FUND_CENTS, currency: "USD" },
        },
      ],
    },
  });
  if (!spendOrder.ok) throw new Error(`spend order: ${errStr(spendOrder)}`);
  const spendOrderId = spendOrder.json.order.id;
  gcPaymentCents = spendOrder.json.order.total_money?.amount ?? FUND_CENTS;

  const spendPay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-sp`,
    source_id: giftCardId,
    amount_money: { amount: gcPaymentCents, currency: "USD" },
    order_id: spendOrderId,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!spendPay.ok) throw new Error(`gift card payment: ${errStr(spendPay)}`);
  gcPaymentId = spendPay.json.payment.id;
  console.log(`paid order ${spendOrderId} with the gift card — payment ${gcPaymentId} (${gcPaymentCents}¢)`);

  // ── 4. THE PROBED CALL — $1 partial refund of a GC-funded payment ─────────
  const partial = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r1`,
    payment_id: gcPaymentId,
    amount_money: { amount: PARTIAL_CENTS, currency: "USD" },
    // Owner convention: every real refund carries EXACTLY this reason — the
    // portal's journal-entry pickup keys off it. No ad-hoc reasons, ever
    // (probe refunds included; learned 2026-07-27).
    reason: "Refund: Reservation Deposit",
  });
  console.log(`\nPROBE A — partial GC refund → ${partial.ok ? "ACCEPTED" : errStr(partial)}`);
  if (partial.ok) {
    verdicts.push(
      "PROBE A: Square ACCEPTED a $1 PARTIAL refund of a gift-card-funded payment via the API " +
        `(refund ${partial.json.refund?.id}, status ${partial.json.refund?.status}). ` +
        "The 2026-07-11 lesson does NOT hold at the API level — update tasks/lessons.md and " +
        "revisit the MID_DECREASE / POST designs.",
    );
  } else {
    verdicts.push(
      `PROBE A: Square REFUSED the partial refund (${codesOf(partial)}) — confirms the ` +
        "2026-07-11 lesson at the API level. Store-credit / unlinked-refund designs stand.",
    );
  }
} catch (e) {
  console.log(`\nchain aborted: ${e instanceof Error ? e.message : e}`);
  verdicts.push(`CHAIN ABORTED mid-flow: ${e instanceof Error ? e.message : e}`);
} finally {
  // ── 5. Zero the GC payment (full-remainder refund back onto the card) ─────
  if (gcPaymentId) {
    const fresh = await sq("GET", `/payments/${gcPaymentId}`);
    const already = fresh.json?.payment?.refunded_money?.amount ?? 0;
    const remainder = gcPaymentCents - already;
    if (remainder > 0) {
      const r = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-r2`,
        payment_id: gcPaymentId,
        amount_money: { amount: remainder, currency: "USD" },
        reason: "Refund: Reservation Deposit",
      });
      console.log(`cleanup: GC payment remainder refund (${remainder}¢) → ${r.ok ? "ok" : errStr(r)}`);
      if (!r.ok) {
        verdicts.push(
          `CLEANUP INCOMPLETE: GC payment ${gcPaymentId} still holds ${remainder}¢ — refund ` +
            "manually in Square, then drain the gift card.",
        );
      }
    }
  }

  // ── 6. WAIT for the refund credits to land on the card, THEN drain ────────
  // Lesson from the first run (2026-07-27): refunds of a GC payment credit the
  // card ASYNCHRONOUSLY — deactivating before the REFUND activities post
  // strands the value. Poll until the expected credits arrive (or ~2 min).
  if (giftCardId) {
    let expectedBack = 0;
    if (gcPaymentId) {
      const p = await sq("GET", `/payments/${gcPaymentId}`);
      expectedBack = p.json?.payment?.refunded_money?.amount ?? 0;
    }
    let bal = 0;
    let state: string | undefined;
    for (let i = 0; i < 24; i++) {
      const gcNow = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
      bal = gcNow?.balance_money?.amount ?? 0;
      state = gcNow?.state;
      if (bal >= expectedBack) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(`cleanup: card balance ${bal}¢ (expected ${expectedBack}¢ back) state=${state}`);
    if (bal < expectedBack) {
      verdicts.push(
        `CLEANUP DEFERRED: refund credits (${expectedBack}¢) had not posted to gift card ` +
          `${giftCardId} after ~2 min — card left ACTIVE. Drain + deactivate it manually once ` +
          "the REFUND activities appear.",
      );
    }
    const gc = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
    if (gc?.state === "ACTIVE" && bal >= expectedBack && bal > 0) {
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
      console.log(`cleanup: drained gift card ${bal}¢ → ${d.ok ? "ok" : errStr(d)}`);
    }
    // Only deactivate once the credits posted and the card is drained —
    // deactivating early is what stranded the first run's refund credits.
    if (bal >= expectedBack) {
      const de = await sq("POST", "/gift-cards/activities", {
        idempotency_key: `${KEY}-deact`,
        gift_card_activity: {
          type: "DEACTIVATE",
          location_id: LOCATION,
          gift_card_id: giftCardId,
          deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
        },
      });
      console.log(`cleanup: deactivate gift card → ${de.ok ? "ok" : errStr(de)}`);
    }
  }

  // ── 7. PROBE C — make-whole: full refund of the purchase → credit card ────
  if (purchasePaymentId) {
    const fresh = await sq("GET", `/payments/${purchasePaymentId}`);
    const already = fresh.json?.payment?.refunded_money?.amount ?? 0;
    const remainder = purchaseCents - already;
    if (remainder > 0) {
      const r = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-r3`,
        payment_id: purchasePaymentId,
        amount_money: { amount: remainder, currency: "USD" },
        reason: "Refund: Reservation Deposit",
      });
      console.log(
        `PROBE C — purchase refund to ${cardOnFile.brand} …${cardOnFile.last4} (${remainder}¢) → ` +
          `${r.ok ? "ok" : errStr(r)}`,
      );
      verdicts.push(
        r.ok
          ? `PROBE C: full refund of the gift-card PURCHASE back to the credit card ACCEPTED ` +
              `(refund ${r.json.refund?.id}, status ${r.json.refund?.status}) — owner made whole.`
          : `PROBE C FAILED (${codesOf(r)}): purchase payment ${purchasePaymentId} still holds ` +
              `${remainder}¢ — REFUND MANUALLY IN SQUARE to make the owner whole.`,
      );
    }
  }
}

// ── 8. PROBE B — unlinked refund entitlement ─────────────────────────────────
// customer_id is REQUIRED when destination_id is a card on file (validation
// finding from the first run — omitting it 400s before the entitlement gate).
const unlinked = await sq("POST", "/refunds", {
  idempotency_key: `${KEY}-u1`,
  unlinked: true,
  destination_id: cardOnFile.id,
  customer_id: customerId,
  amount_money: { amount: UNLINKED_CENTS, currency: "USD" },
  location_id: LOCATION,
  reason: "Refund: Reservation Deposit",
});
console.log(`\nPROBE B — unlinked refund → ${unlinked.ok ? "ACCEPTED" : errStr(unlinked)}`);
verdicts.push(
  unlinked.ok
    ? `PROBE B: unlinked refunds are ENABLED — $1.00 headed to ${cardOnFile.brand} ` +
        `…${cardOnFile.last4} (refund ${unlinked.json.refund?.id}, status ` +
        `${unlinked.json.refund?.status}). The GC→credit-card leg is buildable NOW.`
    : `PROBE B: unlinked refund REFUSED (${codesOf(unlinked)}) — entitlement not enabled yet; ` +
        "stay on Kaitlin's thread.",
);

console.log("\n═══ VERDICTS ═══");
for (const v of verdicts) console.log(`• ${v}`);
