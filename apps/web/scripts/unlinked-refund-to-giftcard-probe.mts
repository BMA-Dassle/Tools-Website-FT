/**
 * Can an unlinked refund be paid out to a GIFT CARD?
 *
 * Established 2026-07-28: the seller entitlement IS on (an unlinked EXTERNAL
 * refund COMPLETED), but an unlinked refund to the owner's CREDIT card on file
 * fails at the money rail (`REFUND_DECLINED`, Refund object reaches FAILED).
 * Square's doc lists a Square gift card as a legal `destination_id`, and a gift
 * card needs no card network at all — so this is both the natural fallback and
 * a second test of the push-vs-permission split.
 *
 * If this works we have a way to hand money back with no payment to link to —
 * store credit for a guest whose original tender is unrefundable — which is
 * exactly the leg the post-day-of refund plan is missing.
 *
 * Steps:
 *   0  fresh gift card, comp-activated then decremented to a clean 0¢ baseline
 *   1  unlinked refund, destination_id = the gift card id  (then GAN as a retry
 *      shape if the id is rejected)
 *   2  poll the refund to a terminal status
 *   3  poll the CARD for a REFUND activity + balance — the credit lands
 *      ASYNCHRONOUSLY (finding G3), so the refund status alone proves nothing
 *   4  drain the card back to 0¢ ONLY after the credit has actually landed
 *      (never DEACTIVATE/decrement with refunds in flight — 7/27 lesson)
 *
 * Non-accounting location. Net money movement: zero (we drain what lands).
 *
 * Run from apps/web:
 *   npx tsx scripts/unlinked-refund-to-giftcard-probe.mts          # dry run
 *   npx tsx scripts/unlinked-refund-to-giftcard-probe.mts --live
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
const SEED = 100; // activate-then-decrement, purely to reach a clean 0¢ card
const CENTS = 400; // one soda, to match the sibling probes
const REASON = "Refund: Reservation Deposit";
const KEY = `unlg-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Would, at ${LOCATION}:`);
  console.log(`  0  create a gift card, comp-activate ${SEED}¢, decrement to 0¢`);
  console.log(`  1  POST /refunds unlinked:true destination_id=<gftc:…> ${CENTS}¢`);
  console.log("  2  poll refund to terminal status");
  console.log("  3  poll the card for a REFUND activity + balance (async credit)");
  console.log("  4  drain back to 0¢ only once the credit has landed");
  console.log("Net money movement: zero.");
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

const findings: string[] = [];
const record = (q: string, a: string) => {
  findings.push(`${q}: ${a}`);
  console.log(`\n>>> ${q}\n    ${a}`);
};

let giftCardId: string | undefined;
let gan: string | undefined;
let refundId: string | undefined;
let creditLanded = false;

try {
  // ── 0. clean 0¢ gift card ────────────────────────────────────────────────
  gan = `WEBPRB${Date.now().toString().slice(-10)}`;
  const create = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan },
  });
  if (!create.ok) throw new Error(`create card: ${errStr(create)}`);
  giftCardId = create.json.gift_card.id as string;
  console.log(`gift card ${giftCardId} gan=${gan} state=${create.json.gift_card.state}`);

  const co = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-co`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "eGiftCard (probe funding)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: SEED, currency: "USD" },
        },
      ],
      discounts: [
        { name: "Probe comp", amount_money: { amount: SEED, currency: "USD" }, scope: "ORDER" },
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
  const dec = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-zero`,
    gift_card_activity: {
      type: "ADJUST_DECREMENT",
      location_id: LOCATION,
      gift_card_id: giftCardId,
      adjust_decrement_activity_details: {
        amount_money: { amount: SEED, currency: "USD" },
        reason: "PURCHASE_WAS_REFUNDED",
      },
    },
  });
  if (!dec.ok) throw new Error(`zero out: ${errStr(dec)}`);
  const base = await sq("GET", `/gift-cards/${giftCardId}`);
  const baseBal = base.json?.gift_card?.balance_money?.amount ?? -1;
  console.log(`baseline: state=${base.json?.gift_card?.state} balance=${baseBal}¢`);

  // ── 1. the unlinked refund, gift card as destination ─────────────────────
  let r = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-u1`,
    unlinked: true,
    destination_id: giftCardId,
    location_id: LOCATION,
    amount_money: { amount: CENTS, currency: "USD" },
    reason: REASON,
  });
  let shape = "gift card id (gftc:…)";
  if (!r.ok) {
    console.log(`  destination_id=<gftc id> refused — ${codes(r)} — ${errStr(r)}`);
    console.log("  retrying with the GAN as destination_id…");
    r = await sq("POST", "/refunds", {
      idempotency_key: `${KEY}-u2`,
      unlinked: true,
      destination_id: gan,
      location_id: LOCATION,
      amount_money: { amount: CENTS, currency: "USD" },
      reason: REASON,
    });
    shape = "GAN";
  }
  record(
    `unlinked ${CENTS}¢ refund, destination = ${shape}`,
    r.ok
      ? `ACCEPTED — refund ${r.json.refund?.id} status=${r.json.refund?.status} ` +
          `destination_type=${r.json.refund?.destination_type ?? "?"}`
      : `REFUSED — ${codes(r)} — ${errStr(r)}`,
  );
  if (!r.ok) throw new Error("both destination shapes refused — nothing further to observe");
  refundId = r.json.refund.id;

  // ── 2. refund to a terminal status ───────────────────────────────────────
  let status = r.json.refund.status;
  for (let i = 0; i < 10 && !["COMPLETED", "FAILED", "REJECTED"].includes(status); i++) {
    await sleep(10_000);
    const g = await sq("GET", `/refunds/${refundId}`);
    status = g.json?.refund?.status ?? "?";
    console.log(`  +${(i + 1) * 10}s refund status=${status}`);
  }
  record("refund terminal status", status);

  // ── 3. did the value actually LAND on the card? (async — G3) ─────────────
  for (let i = 0; i < 10; i++) {
    const cardNow = await sq("GET", `/gift-cards/${giftCardId}`);
    const bal = cardNow.json?.gift_card?.balance_money?.amount ?? 0;
    const acts = await sq("GET", `/gift-cards/activities?gift_card_id=${giftCardId}&limit=50`);
    const kinds = (acts.json?.gift_card_activities ?? []).map((a: any) => a.type);
    console.log(`  +${i * 10}s balance=${bal}¢ activities=[${kinds.join(", ")}]`);
    if (bal >= CENTS || kinds.includes("REFUND")) {
      creditLanded = true;
      record(
        "credit landed on the gift card",
        `YES — balance=${bal}¢, activities=[${kinds.join(", ")}]. An unlinked refund CAN fund a ` +
          `gift card, which is a working "hand money back with no payment to link" path.`,
      );
      break;
    }
    await sleep(10_000);
  }
  if (!creditLanded) {
    record(
      "credit landed on the gift card",
      `NO — after ~100s the balance never rose and no REFUND activity appeared. Refund status was ` +
        `${status}. Same limbo as the itemized-refund/GC-credit blocker: money leaves the refund ` +
        `object but never arrives on the tender. NOT usable as a payout path.`,
    );
  }
} catch (e) {
  console.error(`\nFATAL: ${(e as Error).message}`);
} finally {
  // ── 4. drain ONLY if the credit actually landed ──────────────────────────
  console.log("\n═══ cleanup ═══");
  if (giftCardId) {
    if (creditLanded) {
      const cardNow = await sq("GET", `/gift-cards/${giftCardId}`);
      const bal = cardNow.json?.gift_card?.balance_money?.amount ?? 0;
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
        console.log(`  drain ${bal}¢ → ${d.ok ? "ok, card back to 0¢" : errStr(d)}`);
      } else {
        console.log("  nothing to drain");
      }
    } else {
      console.log(
        `  LEAVING card ${giftCardId} ALONE — a refund may still be in flight. ` +
          `Never decrement/deactivate with refunds pending (7/27 lesson). ` +
          `Re-check: GET /v2/gift-cards/${giftCardId}`,
      );
    }
  }
  console.log("\n═══ FINDINGS ═══");
  for (const f of findings) console.log(`• ${f}`);
}
