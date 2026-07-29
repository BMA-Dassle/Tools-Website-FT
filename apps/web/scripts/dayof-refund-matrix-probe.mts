/**
 * §9 probe matrix for tasks/future/post-dayof-refund-plan.md.
 *
 * Answers the Square behaviors the post-day-of refund design LEANS ON but
 * that the 2026-07-27 runs never actually observed. Each is load-bearing:
 *
 *   Q1  After a PARTIAL refund of a payment attached to an order, what are the
 *       order's state and net_amount_due_money?
 *         → The "strand trap" (an OPEN order reopening a balance due, which
 *           bowling-order-complete then skips forever) and the
 *           refund-acts-as-a-guard argument both depend on this. If a refund
 *           does NOT reopen net_amount_due, the strand trap does not exist and
 *           the complete-cron race window is much wider than assumed.
 *
 *   Q2  Does UpdateOrder (sparse PUT + fields_to_clear) work on an OPEN order
 *       that already has TENDERS — including dropping the total BELOW the
 *       tendered amount?
 *         → Every MID money flow treats this PUT as given. Never verified.
 *
 *   Q3  Can a payment on a COMPLETED order be refunded?
 *         → The 7/27 probe's order stayed OPEN (quick-pay orders never
 *           auto-complete), so the post-complete money-only path is unproven.
 *
 *   Q4  Does payment.refunded_money include a refund that is still PENDING?
 *         → refundTenderPartial clamps against it during the async window; if
 *           PENDING refunds are excluded the clamp over-refunds on a retry.
 *
 *   Q5  Production shape: partial refund of a payment made by an INTERNAL
 *       custom-GAN card (WEBHPFM-style) against a TAXED order.
 *         → 7/27 used a Square-generated GAN and an untaxed order.
 *
 *   Q6  Did the 7/27 stranded credit ever post to probe card …1430?
 *         → Read-only check on the card that was deactivated while its refunds
 *           were PENDING.
 *
 * Owner rules honored: runs ONLY at the non-accounting location
 * 6MZJFTGAYD7TC; the deposit/cash leg carries "Refund: Reservation Deposit"
 * while the day-of leg carries its own descriptive reason.
 *
 * Self-cleaning: every payment is refunded to zero and every card drained +
 * deactivated (AFTER its credits post), in a finally block.
 *
 * DRY RUN by default. From apps/web:
 *   npx tsx scripts/dayof-refund-matrix-probe.mts --live
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
// Owner rule (2026-07-27): probes NEVER touch a revenue location.
const LOCATION = "6MZJFTGAYD7TC";
const DEPOSIT_REASON = "Refund: Reservation Deposit"; // cash leg only
const DAYOF_REASON = "Probe: day-of item removed"; // staff-supplied style
const ITEM_CENTS = 1000; // 2 × $10 lines
const KEY = `mtx-${randomUUID().slice(0, 8)}`;
/** The 7/27 probe card that was deactivated with refunds still PENDING. */
const STRANDED_CARD = "gftc:53a7edf0904e4dc684c0945ec0080ec9";

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Location ${LOCATION} (non-accounting)`);
  console.log("Q1 order state + net_amount_due after a partial refund");
  console.log("Q2 UpdateOrder w/ fields_to_clear on a TENDERED open order");
  console.log("Q3 refund a payment on a COMPLETED order");
  console.log("Q4 does refunded_money include a PENDING refund");
  console.log("Q5 custom-GAN internal card + TAXED order (production shape)");
  console.log("Q6 read-only: did card …1430's 7/27 credit ever post");
  console.log("Cleanup: refund all payments to zero, drain + deactivate cards");
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
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}
const errStr = (r: { status: number; json: any }): string =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 300)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const findings: string[] = [];
const record = (q: string, answer: string) => {
  findings.push(`${q}: ${answer}`);
  console.log(`\n>>> ${q}: ${answer}`);
};

// ── Location sanity ──────────────────────────────────────────────────────────
const loc = await sq("GET", `/locations/${LOCATION}`);
if (!loc.ok) {
  console.log(`LOCATION CHECK FAILED: ${errStr(loc)}`);
  process.exit(2);
}
console.log(`location OK — ${loc.json.location?.name} (${LOCATION})`);

// ── Q6 first: read-only, no setup needed ─────────────────────────────────────
{
  const gc = await sq("GET", `/gift-cards/${STRANDED_CARD}`);
  const card = gc.json?.gift_card;
  const acts = await sq(
    "GET",
    `/gift-cards/activities?gift_card_id=${encodeURIComponent(STRANDED_CARD)}&limit=30`,
  );
  const types = (acts.json?.gift_card_activities ?? []).map((a: any) => a.type);
  const refundActs = types.filter((t: string) => t === "REFUND").length;
  record(
    "Q6 stranded 7/27 credit",
    `card is ${card?.state} at ${card?.balance_money?.amount ?? "?"}¢; activities=[${types.join(", ")}]; ` +
      `REFUND activities=${refundActs} → ${
        refundActs > 0
          ? "the credit DID post"
          : "NO refund credit ever posted — deactivating with refunds pending loses the money"
      }`,
  );
}

let giftCardId: string | undefined;
let paymentId: string | undefined;
let orderId: string | undefined;
let paidCents = 0;

try {
  // ── Setup: custom-GAN internal card + TAXED 2-line order (Q5 shape) ───────
  const customGan = `WEBPRB${Date.now().toString().slice(-10)}`;
  const create = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan: customGan },
  });
  if (!create.ok) throw new Error(`custom-GAN create: ${errStr(create)}`);
  giftCardId = create.json.gift_card.id as string;
  console.log(`internal-shape card ${giftCardId} gan=${customGan}`);

  // Fund it the way mintDigitalGiftCard does: Square rejects a bare
  // amount_money on ACTIVATE ("provide either order_id and line_item_uid OR
  // amount and buyer_payment_instrument_id"), so comp a $0 order carrying a
  // GIFT_CARD line and activate against that line.
  const FUND = ITEM_CENTS * 3;
  const compOrder = await sq("POST", "/orders", {
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
  if (!compOrder.ok) throw new Error(`comp order: ${errStr(compOrder)}`);
  const compOrderId = compOrder.json.order.id as string;
  const compLineUid = compOrder.json.order.line_items[0].uid as string;

  const compPay = await sq("POST", `/orders/${compOrderId}/pay`, {
    idempotency_key: `${KEY}-cp`,
    payment_ids: [],
  });
  if (!compPay.ok) throw new Error(`comp $0 pay: ${errStr(compPay)}`);

  const act = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-act`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION,
      gift_card_id: giftCardId,
      activate_activity_details: { order_id: compOrderId, line_item_uid: compLineUid },
    },
  });
  if (!act.ok) throw new Error(`activate: ${errStr(act)}`);
  const funded = act.json.gift_card_activity?.gift_card_balance_money?.amount ?? 0;
  if (funded <= 0) throw new Error(`activate returned ${funded}¢`);
  console.log(`card funded ${funded}¢`);

  // TAXED order, two removable lines (ad-hoc 7% tax mirrors FL county tax).
  const orderRes = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-o`,
    order: {
      location_id: LOCATION,
      line_items: [
        { uid: "L1", name: "Probe item A", quantity: "1", base_price_money: { amount: ITEM_CENTS, currency: "USD" } },
        { uid: "L2", name: "Probe item B", quantity: "1", base_price_money: { amount: ITEM_CENTS, currency: "USD" } },
      ],
      taxes: [{ uid: "TX", name: "Probe tax", percentage: "7", scope: "ORDER" }],
    },
  });
  if (!orderRes.ok) throw new Error(`order: ${errStr(orderRes)}`);
  orderId = orderRes.json.order.id as string;
  const orderTotal = orderRes.json.order.total_money?.amount ?? 0;
  console.log(`taxed order ${orderId} total=${orderTotal}¢ state=${orderRes.json.order.state}`);

  // Pay it with the internal-shape card.
  const pay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-p`,
    source_id: giftCardId,
    amount_money: { amount: orderTotal, currency: "USD" },
    order_id: orderId,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!pay.ok) throw new Error(`gc payment: ${errStr(pay)}`);
  paymentId = pay.json.payment.id as string;
  paidCents = orderTotal;
  const afterPay = await sq("GET", `/orders/${orderId}`);
  console.log(
    `paid ${orderTotal}¢ — payment ${paymentId}; order now state=${afterPay.json?.order?.state} ` +
      `net_due=${afterPay.json?.order?.net_amount_due_money?.amount ?? 0}¢`,
  );
  const stateAfterPay = afterPay.json?.order?.state;

  // ── Q5 + Q1: partial refund of the internal-card payment on a TAXED order ─
  const share = Math.round(ITEM_CENTS * 1.07); // one line, tax-inclusive
  const partial = await sq("POST", "/refunds", {
    idempotency_key: `${KEY}-r1`,
    payment_id: paymentId,
    amount_money: { amount: share, currency: "USD" },
    reason: DAYOF_REASON,
  });
  record(
    "Q5 partial refund, internal custom-GAN card + taxed order",
    partial.ok
      ? `ACCEPTED ${share}¢ (refund ${partial.json.refund?.id}, status ${partial.json.refund?.status})`
      : `REFUSED — ${errStr(partial)}`,
  );
  if (!partial.ok) throw new Error("Q5 failed — remaining probes depend on it");
  const refundId = partial.json.refund.id as string;

  // Q4: read the payment IMMEDIATELY, while the refund is likely PENDING.
  const payNow = await sq("GET", `/payments/${paymentId}`);
  const refundedNow = payNow.json?.payment?.refunded_money?.amount ?? 0;
  const refStatusNow = (await sq("GET", `/refunds/${refundId}`)).json?.refund?.status;
  record(
    "Q4 refunded_money during the async window",
    `refund status=${refStatusNow}, payment.refunded_money=${refundedNow}¢ of ${share}¢ asked → ` +
      `${
        refundedNow >= share
          ? "INCLUDES pending refunds (clamp math is safe)"
          : "EXCLUDES pending refunds — a retry could over-refund; clamp must list refunds, not trust refunded_money"
      }`,
  );

  // Q1: what did the refund do to the ORDER?
  const orderAfter = await sq("GET", `/orders/${orderId}`);
  const o = orderAfter.json?.order;
  record(
    "Q1 order after a partial refund",
    `state=${o?.state} (was ${stateAfterPay}) total=${o?.total_money?.amount}¢ ` +
      `net_amount_due=${o?.net_amount_due_money?.amount ?? 0}¢ → ${
        (o?.net_amount_due_money?.amount ?? 0) > 0
          ? "REOPENS a balance due — the strand trap is REAL (bowling-order-complete would skip this order)"
          : "does NOT reopen a balance due — the strand trap does NOT exist; refunds are not a guard against the complete-cron"
      }`,
  );

  // ── Q2: UpdateOrder with fields_to_clear on a TENDERED order ──────────────
  if (o?.state === "OPEN") {
    const upd = await sq("PUT", `/orders/${orderId}`, {
      idempotency_key: `${KEY}-u1`,
      order: { location_id: LOCATION, version: o.version },
      fields_to_clear: ["line_items[L2]"],
    });
    record(
      "Q2 UpdateOrder + fields_to_clear on a TENDERED open order",
      upd.ok
        ? `ACCEPTED — new total ${upd.json.order?.total_money?.amount}¢, ` +
            `net_due ${upd.json.order?.net_amount_due_money?.amount ?? 0}¢ ` +
            `(dropping total below the tendered amount is allowed)`
        : `REFUSED — ${errStr(upd)}`,
    );
  } else {
    record(
      "Q2 UpdateOrder + fields_to_clear on a TENDERED open order",
      `SKIPPED — the order is ${o?.state}, not OPEN (quick-pay auto-closed it), so a MID-phase ` +
        `line PUT cannot be exercised this way`,
    );
  }

  // ── Q3: refund a payment on a COMPLETED order ─────────────────────────────
  const preQ3 = await sq("GET", `/orders/${orderId}`);
  let q3State = preQ3.json?.order?.state;
  if (q3State === "OPEN") {
    // Try to close it so the COMPLETED case can be tested.
    const done = await sq("PUT", `/orders/${orderId}`, {
      idempotency_key: `${KEY}-comp`,
      order: { location_id: LOCATION, version: preQ3.json.order.version, state: "COMPLETED" },
    });
    q3State = done.ok ? "COMPLETED" : q3State;
    console.log(`close order for Q3 → ${done.ok ? "COMPLETED" : errStr(done)}`);
  }
  if (q3State === "COMPLETED") {
    const q3 = await sq("POST", "/refunds", {
      idempotency_key: `${KEY}-r2`,
      payment_id: paymentId,
      amount_money: { amount: share, currency: "USD" },
      reason: DAYOF_REASON,
    });
    record(
      "Q3 refund a payment on a COMPLETED order",
      q3.ok
        ? `ACCEPTED (refund ${q3.json.refund?.id}) — the money-only post-complete path is valid`
        : `REFUSED — ${errStr(q3)}`,
    );
  } else {
    record("Q3 refund a payment on a COMPLETED order", `SKIPPED — could not reach COMPLETED`);
  }
} catch (e) {
  console.log(`\nprobe aborted: ${e instanceof Error ? e.message : e}`);
  findings.push(`ABORTED: ${e instanceof Error ? e.message : e}`);
} finally {
  console.log("\n— cleanup —");
  // Refund the payment to zero (cash-leg convention on the reversal).
  if (paymentId) {
    const p = await sq("GET", `/payments/${paymentId}`);
    const remaining = paidCents - (p.json?.payment?.refunded_money?.amount ?? 0);
    if (remaining > 0) {
      const r = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-rz`,
        payment_id: paymentId,
        amount_money: { amount: remaining, currency: "USD" },
        reason: DEPOSIT_REASON,
      });
      console.log(`refund remainder ${remaining}¢ → ${r.ok ? "ok" : errStr(r)}`);
    }
  }
  // WAIT for credits before touching the card (the 7/27 lesson).
  if (giftCardId) {
    let bal = 0;
    let last = -1;
    for (let i = 0; i < 24; i++) {
      bal = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.balance_money?.amount ?? 0;
      if (bal === last && bal > 0) break; // stable and non-zero
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
      console.log(`drain ${bal}¢ → ${d.ok ? "ok" : errStr(d)}`);
    }
    const after = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
    if (after?.state === "PENDING") {
      // Never activated (setup aborted) — nothing to drain, nothing at risk.
      console.log("card never activated — nothing to clean up");
    } else if ((after?.balance_money?.amount ?? 0) === 0) {
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
      console.log(`card still holds ${after?.balance_money?.amount}¢ — left ACTIVE for review`);
    }
  }
}

console.log("\n═══ §9 FINDINGS ═══");
for (const f of findings) console.log(`• ${f}`);
