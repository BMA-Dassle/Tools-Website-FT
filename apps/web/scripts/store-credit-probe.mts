/**
 * $1 live probe: can a Square gift card PAY FOR a gift-card sale?
 *
 * Decides STORE_CREDIT_STRATEGY for the cancellation cascade
 * (src/features/cancellation/store-credit.ts):
 *   exit 0  → "purchase" works (owner-preferred): set STORE_CREDIT_STRATEGY=purchase
 *   exit 1  → Square rejected the gift-card tender: keep STORE_CREDIT_STRATEGY=comp
 *
 * Sequence (all against the live production account — amounts are $1 and every
 * object is cleaned up before exit):
 *   1. Comp-mint a $1 DIGITAL "funding" card (stands in for an internal
 *      deposit card as a payment source; mintDigitalGiftCard is the same
 *      prod-proven path survey rewards use).
 *   2. Create an order with one $1 GIFT_CARD line item.
 *   3. CreatePayment with source_id = the funding card  ← THE PROBED CALL.
 *   4. On success: create + ACTIVATE a new card against the order, verify $1.
 *   5. Cleanup: drain + deactivate every card this probe touched; cancel the
 *      order if it never got paid. Zero liabilities left either way.
 *
 * DRY RUN by default (prints the plan). Pass --live to execute.
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
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const LOCATION = "TXBSQN0FEKQ11"; // HeadPinz Fort Myers
const AMOUNT = 100; // $1.00
const KEY = `probe-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Would: comp-mint $1 funding card @ ${LOCATION}`);
  console.log("Would: create $1 GIFT_CARD-line order");
  console.log("Would: CreatePayment(source_id = funding card) ← the probed call");
  console.log("Would: on success, create+ACTIVATE a new card, verify $1 balance");
  console.log("Would: drain + deactivate all probe cards; cancel order if unpaid");
  process.exit(0);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
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

async function drainAndDeactivate(giftCardId: string, label: string): Promise<void> {
  const gc = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
  if (!gc) {
    console.log(`  cleanup ${label}: fetch failed — check ${giftCardId} manually`);
    return;
  }
  const bal = gc.balance_money?.amount ?? 0;
  if (gc.state === "ACTIVE" && bal > 0) {
    const r = await sq("POST", "/gift-cards/activities", {
      idempotency_key: `${KEY}-drain-${giftCardId.slice(-6)}`,
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
    console.log(`  cleanup ${label}: drained ${bal}¢ → ${r.ok ? "ok" : "FAILED " + JSON.stringify(r.json?.errors)}`);
  }
  const state = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.state;
  if (state === "ACTIVE") {
    const r = await sq("POST", "/gift-cards/activities", {
      idempotency_key: `${KEY}-deact-${giftCardId.slice(-6)}`,
      gift_card_activity: {
        type: "DEACTIVATE",
        location_id: LOCATION,
        gift_card_id: giftCardId,
        deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
      },
    });
    console.log(`  cleanup ${label}: deactivate → ${r.ok ? "ok" : "FAILED " + JSON.stringify(r.json?.errors)}`);
  }
}

const cleanupCards: Array<{ id: string; label: string }> = [];
let orderIdToCancel: string | null = null;
let verdict: "purchase" | "comp" | "inconclusive" = "inconclusive";

try {
  // ── 1. Funding card (comp mint, prod-proven pattern) ──────────────────────
  const { mintDigitalGiftCard } = await import("@/lib/square-gift-card");
  const discountId =
    process.env.SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID ||
    process.env.SQUARE_SURVEY_DISCOUNT_CATALOG_ID ||
    "37C3SN4245TUCN3RF7XMNKPU";
  console.log(`1. comp-minting $1 funding card (discount ${discountId})…`);
  const funding = await mintDigitalGiftCard({
    locationId: LOCATION,
    amountCents: AMOUNT,
    baseKey: `${KEY}-fund`,
    discountCatalogObjectId: discountId,
  });
  cleanupCards.push({ id: funding.giftCardId, label: "funding card" });
  console.log(`   funding card ${funding.giftCardId} gan=${funding.gan} $1 ACTIVE`);

  // ── 2. $1 GIFT_CARD-line order ─────────────────────────────────────────────
  console.log("2. creating $1 GIFT_CARD-line order…");
  const orderRes = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-order`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "Store Credit Probe",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: AMOUNT, currency: "USD" },
        },
      ],
    },
  });
  if (!orderRes.ok) throw new Error(`order create failed: ${JSON.stringify(orderRes.json?.errors)}`);
  const orderId = orderRes.json.order.id as string;
  const lineItemUid = orderRes.json.order.line_items[0].uid as string;
  orderIdToCancel = orderId;
  console.log(`   order ${orderId}`);

  // ── 3. THE PROBED CALL — pay a gift-card sale WITH a gift card ────────────
  console.log("3. CreatePayment(source_id = funding gift card)…");
  const payRes = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-pay`,
    source_id: funding.giftCardId,
    amount_money: { amount: AMOUNT, currency: "USD" },
    order_id: orderId,
    location_id: LOCATION,
    autocomplete: true,
  });

  if (!payRes.ok) {
    verdict = "comp";
    console.log("   ✗ REJECTED — Square refused the gift-card tender on a gift-card sale.");
    console.log(`   error: ${JSON.stringify(payRes.json?.errors ?? payRes.json).slice(0, 400)}`);
  } else {
    orderIdToCancel = null; // paid — no cancel possible or needed
    console.log(`   ✓ payment ${payRes.json.payment.id} accepted`);

    // ── 4. Finish strategy A end-to-end: create + activate + verify ────────
    console.log("4. creating + activating the new card against the paid order…");
    const createRes = await sq("POST", "/gift-cards", {
      idempotency_key: `${KEY}-mint`,
      location_id: LOCATION,
      gift_card: { type: "DIGITAL" },
    });
    if (!createRes.ok) throw new Error(`card create failed: ${JSON.stringify(createRes.json?.errors)}`);
    const newCard = createRes.json.gift_card;
    cleanupCards.push({ id: newCard.id, label: "new card" });
    const actRes = await sq("POST", "/gift-cards/activities", {
      idempotency_key: `${KEY}-act`,
      gift_card_activity: {
        type: "ACTIVATE",
        location_id: LOCATION,
        gift_card_id: newCard.id,
        activate_activity_details: { order_id: orderId, line_item_uid: lineItemUid },
      },
    });
    if (!actRes.ok) throw new Error(`activate failed: ${JSON.stringify(actRes.json?.errors)}`);
    const verify = (await sq("GET", `/gift-cards/${newCard.id}`)).json?.gift_card;
    if (verify?.state === "ACTIVE" && verify?.balance_money?.amount === AMOUNT) {
      verdict = "purchase";
      console.log(`   ✓ new card ${newCard.id} gan=${newCard.gan} ACTIVE $1 — full sequence works`);
    } else {
      verdict = "inconclusive";
      console.log(
        `   ? activation odd: state=${verify?.state} balance=${verify?.balance_money?.amount} — investigate before enabling purchase`,
      );
    }
  }
} catch (err) {
  console.error("PROBE ERROR:", err instanceof Error ? err.message : err);
} finally {
  console.log("cleanup:");
  if (orderIdToCancel) {
    const o = (await sq("GET", `/orders/${orderIdToCancel}`)).json?.order;
    if (o && o.state === "OPEN" && !(o.tenders?.length > 0)) {
      const r = await sq("PUT", `/orders/${orderIdToCancel}`, {
        order: { location_id: o.location_id, version: o.version, state: "CANCELED" },
      });
      console.log(`  probe order cancelled → ${r.ok ? "ok" : "FAILED"}`);
    }
  }
  for (const c of cleanupCards) await drainAndDeactivate(c.id, c.label);
}

console.log(`\nVERDICT: ${verdict.toUpperCase()}`);
if (verdict === "purchase") {
  console.log("→ set STORE_CREDIT_STRATEGY=purchase (Vercel + .env.local)");
  process.exit(0);
} else {
  console.log("→ keep STORE_CREDIT_STRATEGY=comp (the default)");
  process.exit(1);
}
