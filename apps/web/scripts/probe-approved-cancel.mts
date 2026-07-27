/**
 * $1 live probe: cancel semantics for APPROVED (autocomplete:false) payments —
 * the kiosk sweep/abandon design depends on this.
 *
 * Questions this settles:
 *   (a) Does a gift-card auth (autocomplete:false) HOLD the card balance while
 *       the payment sits APPROVED?
 *   (b) Does POST /payments/{id}/cancel void a gift-card-funded APPROVED
 *       payment and restore the balance?
 *   (c) Does POST /payments/{id}/cancel void a TERMINAL-created APPROVED
 *       payment (reader tap with autocomplete:false)? This is the sweep's
 *       ability to void abandoned reader auths.
 *   (d) What does POST /terminals/checkouts/{id}/cancel do to a PENDING
 *       (never-tapped) checkout — and does a payment object ever exist?
 *
 * Sequence (all against LIVE PRODUCTION Square; $1 amounts, nothing captured):
 *   PART A — headless, $0 exposure:
 *     1. Comp-mint a $1 DIGITAL funding gift card (mintDigitalGiftCard, the
 *        prod-proven survey-reward path). Create a $1 order. CreatePayment
 *        source=the gift card, autocomplete:false → expect APPROVED.
 *     2. GET the gift card — record whether the balance is held during auth.
 *     3. POST /payments/{id}/cancel → verify payment CANCELED; GET the gift
 *        card again → verify the balance was restored (print before/after).
 *     4. Cleanup Part A IMMEDIATELY (drain + deactivate the gift card, cancel
 *        order A) — before Part B's interactive tap wait, so a walk-away or
 *        Ctrl-C during the wait leaves nothing from Part A behind.
 *   PART B — only when --device <terminal deviceId> is given; needs ONE human
 *   tap on the reader; the $1 auth is canceled, never captured → $0 settles:
 *     5. Create a $1 order. Terminal checkout autocomplete:false + order_id
 *        (full $1 = the order's net due — partial isn't in play). Poll until
 *        COMPLETED (the tap) → the payment should be APPROVED.
 *     6. POST /payments/{id}/cancel on that terminal APPROVED payment →
 *        verify CANCELED.
 *     7. Create another checkout (amount-only, no order) and while it is
 *        still PENDING (before any tap) POST /terminals/checkouts/{id}/cancel
 *        → verify cancel semantics + whether a payment object ever existed.
 *     8. Cleanup: cancel order(s); any payment left APPROVED → cancel; any
 *        checkout left un-terminal → cancel.
 *
 * Exit-code contract:
 *   0 — every requested part ran CONCLUSIVELY (a definitive answer, positive
 *       or negative, to each probed question; dry run also exits 0)
 *   2 — anything inconclusive (auth never happened, tap timed out, verify
 *       failed, unexpected states); ALSO: .env.local missing (run from
 *       apps/web), SIGINT/SIGTERM (cleanup runs first, then exit 2), or an
 *       unexpected crash (uncaughtException / unhandledRejection — cleanup
 *       still attempted). Exit 1 is never produced.
 *
 * Cleanup guarantee: every created object is tracked (and its id PRINTED) the
 * moment it exists, then resolved by cleanup() — run mid-probe right after
 * Part A, from the finally block, and from the SIGINT/SIGTERM + crash
 * handlers — PENDING checkouts canceled, APPROVED payments canceled, captured
 * payments (should never happen here) refunded in full, probe gift cards
 * drained (ADJUST_DECREMENT) + DEACTIVATEd only after their balance is
 * confirmed stable-empty, unpaid orders canceled — an order with a genuinely
 * CAPTURED tender is flagged "manual review" instead (voided/canceled tenders
 * never block the cancel attempt). Every cleanup unit is fault-isolated: one
 * failure prints a "MANUAL ACTION" line and the rest still runs; the VERDICT
 * always prints. Zero liabilities left either way.
 *
 * DRY RUN by default (prints the plan). Pass --live to execute.
 * Usage: npx tsx scripts/probe-approved-cancel.mts [--live] [--location <id>] [--device <deviceId>]
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {
  console.error("Could not read .env.local — run from apps/web (needs .env.local).");
  process.exit(2);
}

const LIVE = process.argv.includes("--live");
function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}
const LOCATION = argVal("--location") || "LAB52GY480CJF"; // FastTrax Fort Myers (kiosk reader venue)
const DEVICE = argVal("--device"); // Square Terminal deviceId — enables Part B
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const AMOUNT = 100; // $1.00
const KEY = `probe-${randomUUID().slice(0, 8)}`;

console.log("\x1b[1m*** LIVE PRODUCTION SQUARE ACCOUNT — location " + LOCATION + " ***\x1b[0m");

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("PART A (headless, $0 exposure):");
  console.log(`  1. Would: comp-mint $1 DIGITAL funding gift card @ ${LOCATION}`);
  console.log("         (POST /orders GC-line+comp-discount → POST /orders/{id}/pay $0");
  console.log("          → POST /gift-cards → POST /gift-cards/activities ACTIVATE)");
  console.log("     Would: POST /orders — $1 probe order A");
  console.log("     Would: POST /payments source_id=<gift card> autocomplete:false → APPROVED");
  console.log("  2. Would: GET /gift-cards/{id} — is the balance held during the auth?");
  console.log("  3. Would: POST /payments/{id}/cancel → GET /payments/{id} verify CANCELED");
  console.log("     Would: GET /gift-cards/{id} — verify balance restored (print before/after)");
  console.log("  4. Would: drain (ADJUST_DECREMENT) + deactivate the gift card; cancel order A");
  console.log("         (runs IMMEDIATELY here — before Part B's tap wait — not just at exit)");
  if (DEVICE) {
    console.log(`PART B (--device ${DEVICE} — ONE human tap needed, auth canceled, $0 settles):`);
    console.log("  5. Would: POST /orders — $1 probe order B");
    console.log("     Would: POST /terminals/checkouts autocomplete:false order_id=B amount=$1");
    console.log("     Would: poll GET /terminals/checkouts/{id} until COMPLETED (tap a card)");
    console.log("  6. Would: GET /payments/{payId} (expect APPROVED) → POST /payments/{payId}/cancel");
    console.log("     Would: GET /payments/{payId} verify CANCELED");
    console.log("  7. Would: POST /terminals/checkouts (amount-only, NO tap) → while PENDING");
    console.log("     Would: POST /terminals/checkouts/{id}/cancel → verify + payment existence");
    console.log("  8. Would: cancel order B; cancel any payment left APPROVED; cancel stray checkouts");
  } else {
    console.log("PART B: skipped — pass --device <terminal deviceId> to probe reader auth cancel.");
  }
  process.exit(0);
}

if (!TOKEN) {
  console.error("SQUARE_ACCESS_TOKEN is not set (.env.local). Cannot run --live.");
  process.exit(2);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  try {
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
  } catch (err) {
    // NEVER throw — a rejected fetch becomes a status-0 NETWORK error, so no
    // caller (main flow or cleanup) can be killed by a transient network drop.
    return { ok: false, status: 0, json: { errors: [{ code: "NETWORK", detail: String(err) }] } };
  }
}

const maskGan = (gan: string | undefined) => (gan ? `···${gan.slice(-4)}` : "(none)");
const errStr = (json: any) => JSON.stringify(json?.errors ?? json).slice(0, 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getPayment(id: string): Promise<any> {
  // GET /payments/{id} — standard v2 REST shape; repo only creates/cancels payments.
  return (await sq("GET", `/payments/${id}`)).json?.payment ?? null;
}
async function getPaymentRetry(id: string, tries = 3, gapMs = 2000): Promise<any> {
  // A transient fetch failure must never masquerade as a payment-status
  // verdict — retry the GET before returning null.
  let pay = await getPayment(id);
  for (let i = 1; pay === null && i < tries; i++) {
    await sleep(gapMs);
    pay = await getPayment(id);
  }
  return pay;
}
async function getGiftCard(id: string): Promise<any> {
  return (await sq("GET", `/gift-cards/${id}`)).json?.gift_card ?? null;
}
async function getCheckout(id: string): Promise<any> {
  return (await sq("GET", `/terminals/checkouts/${id}`)).json?.checkout ?? null;
}

async function drainAndDeactivate(giftCardId: string, label: string): Promise<void> {
  // A just-canceled GC auth restores the balance ASYNCHRONOUSLY — when the
  // card reads empty, re-poll up to ~5s before believing it. Deactivating
  // before the void posts would strand the restored balance forever.
  let gc = await getGiftCard(giftCardId);
  if (!gc) {
    await sleep(2000);
    gc = await getGiftCard(giftCardId);
  }
  if (!gc) {
    console.log(`  MANUAL ACTION: gift card ${giftCardId} (${label}) — fetch failed; drain + deactivate it manually`);
    return;
  }
  let bal = gc.balance_money?.amount ?? 0;
  const stableDeadline = Date.now() + 5000;
  while (bal === 0 && Date.now() < stableDeadline) {
    await sleep(1500);
    const again = await getGiftCard(giftCardId);
    if (again) {
      gc = again;
      bal = gc.balance_money?.amount ?? 0;
    }
  }
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
    console.log(`  cleanup ${label}: drained ${bal}¢ → ${r.ok ? "ok" : "FAILED " + errStr(r.json)}`);
    if (!r.ok) {
      console.log(`  MANUAL ACTION: gift card ${giftCardId} (${label}) — drain of ${bal}¢ failed; drain + deactivate manually`);
      return; // never deactivate with a balance still on the card
    }
  }
  // Only DEACTIVATE once the card is CONFIRMED ACTIVE + empty — never with a
  // balance (or an unconfirmable one) still on it.
  const after = await getGiftCard(giftCardId);
  const afterBal = after?.balance_money?.amount ?? -1;
  if (after?.state === "ACTIVE" && afterBal === 0) {
    const r = await sq("POST", "/gift-cards/activities", {
      idempotency_key: `${KEY}-deact-${giftCardId.slice(-6)}`,
      gift_card_activity: {
        type: "DEACTIVATE",
        location_id: LOCATION,
        gift_card_id: giftCardId,
        // SUSPICIOUS_ACTIVITY is the only reason enum Square accepts here.
        deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
      },
    });
    console.log(`  cleanup ${label}: deactivate → ${r.ok ? "ok" : "FAILED " + errStr(r.json)}`);
    if (!r.ok) console.log(`  MANUAL ACTION: gift card ${giftCardId} (${label}) — deactivate failed; deactivate manually`);
  } else if (after?.state === "ACTIVE") {
    console.log(
      `  MANUAL ACTION: gift card ${giftCardId} (${label}) — still ACTIVE with ${afterBal === -1 ? "unknown" : `${afterBal}¢`} balance after drain; drain + deactivate manually`,
    );
  } else if (!after) {
    console.log(`  MANUAL ACTION: gift card ${giftCardId} (${label}) — post-drain fetch failed; verify drained + deactivated manually`);
  } else {
    console.log(`  cleanup ${label}: state ${after.state} — nothing to do`);
  }
}

// ── Tracking — push the moment an object exists, BEFORE the next call ───────
const cleanupCards: Array<{ id: string; label: string }> = [];
const ordersToCancel: Array<{ id: string; label: string }> = [];
const paymentsToResolve: Array<{ id: string; label: string }> = [];
const checkoutsToResolve: Array<{ id: string; label: string }> = [];

async function createTerminalCheckoutRecovering(
  label: string,
  idempotencyKey: string,
  checkout: any,
): Promise<{ ok: boolean; status: number; json: any }> {
  let res = await sq("POST", "/terminals/checkouts", { idempotency_key: idempotencyKey, checkout });
  if (!res.ok && res.status === 0) {
    // Network failure — Square may still have created (and armed the reader
    // for) the checkout. Replay the SAME idempotency key: Square returns the
    // original object if it exists, recovering the id for tracking/cleanup.
    console.log(`   ! ${label} create network-failed — replaying idempotency key to recover the id…`);
    res = await sq("POST", "/terminals/checkouts", { idempotency_key: idempotencyKey, checkout });
  }
  if (res.ok) {
    checkoutsToResolve.push({ id: res.json.checkout.id as string, label });
  } else if (res.status === 0) {
    console.log(`   MANUAL: reader may be armed — a checkout with idempotency key ${idempotencyKey} may exist; find + cancel it`);
  }
  return res;
}

// ── Cleanup — callable mid-run (right after Part A), from the finally block,
//    and from the signal/crash handlers. Each unit is fault-isolated (its own
//    try/catch → "MANUAL ACTION" line + continue); a pass can never throw. ───
async function cleanupPass(): Promise<void> {
  // Checkouts first, so the reader disarms before payments/orders are touched.
  while (checkoutsToResolve.length) {
    const c = checkoutsToResolve.shift()!;
    try {
      const co = await getCheckout(c.id);
      if (!co) {
        console.log(`  MANUAL ACTION: checkout ${c.id} (${c.label}) — fetch failed; verify it is CANCELED and no payment exists`);
        continue;
      }
      if (co.status === "PENDING" || co.status === "IN_PROGRESS" || co.status === "CANCEL_REQUESTED") {
        const r = await sq("POST", `/terminals/checkouts/${c.id}/cancel`, {});
        console.log(`  ${c.label}: cancel (was ${co.status}) → ${r.ok ? "ok" : "FAILED " + errStr(r.json)}`);
        if (!r.ok) console.log(`  MANUAL ACTION: checkout ${c.id} (${c.label}) — cancel failed; cancel it on the reader/dashboard`);
      } else {
        console.log(`  ${c.label}: already ${co.status} — nothing to do`);
      }
      // Any payments the checkout minted that we never tracked (e.g. crash mid-poll).
      for (const pid of (co.payment_ids as string[] | undefined) ?? []) {
        if (!paymentsToResolve.some((p) => p.id === pid)) {
          paymentsToResolve.push({ id: pid, label: `${c.label} payment` });
        }
      }
    } catch (err) {
      console.log(`  MANUAL ACTION: checkout ${c.id} (${c.label}) — cleanup threw (${String(err)}); verify it is CANCELED`);
    }
  }
  while (paymentsToResolve.length) {
    const p = paymentsToResolve.shift()!;
    try {
      const pay = await getPaymentRetry(p.id, 2);
      if (!pay) {
        console.log(`  MANUAL ACTION: payment ${p.id} (${p.label}) — fetch failed; verify it is CANCELED/refunded`);
        continue;
      }
      if (pay.status === "APPROVED") {
        const r = await sq("POST", `/payments/${p.id}/cancel`, {
          idempotency_key: `${KEY}-clcan-${p.id.slice(-6)}`,
        });
        console.log(`  ${p.label}: cancel APPROVED auth → ${r.ok ? "ok" : "FAILED " + errStr(r.json)}`);
        if (!r.ok) console.log(`  MANUAL ACTION: payment ${p.id} (${p.label}) — APPROVED auth cancel failed; void it manually`);
      } else if (pay.status === "COMPLETED") {
        // Should never happen in this probe (nothing is captured by design) —
        // refund in full so no money is kept. Mirrors refundSquarePayment
        // (lib/square-gift-card.ts) — standard POST /refunds shape.
        const amt = pay.amount_money?.amount ?? AMOUNT;
        const r = await sq("POST", "/refunds", {
          idempotency_key: `${KEY}-refund-${p.id.slice(-6)}`,
          payment_id: p.id,
          amount_money: { amount: amt, currency: "USD" },
          reason: "Approved-cancel probe cleanup",
        });
        console.log(`  ${p.label}: was CAPTURED — refunded ${amt}¢ → ${r.ok ? "ok" : "FAILED " + errStr(r.json)}`);
        if (!r.ok) console.log(`  MANUAL ACTION: payment ${p.id} (${p.label}) — CAPTURED and refund failed; refund ${amt}¢ manually`);
      } else {
        console.log(`  ${p.label}: status ${pay.status} — nothing to do`);
      }
    } catch (err) {
      console.log(`  MANUAL ACTION: payment ${p.id} (${p.label}) — cleanup threw (${String(err)}); verify it is not APPROVED/COMPLETED`);
    }
  }
  while (ordersToCancel.length) {
    const o = ordersToCancel.shift()!;
    try {
      const ord = (await sq("GET", `/orders/${o.id}`)).json?.order;
      if (!ord) {
        console.log(`  MANUAL ACTION: order ${o.id} (${o.label}) — fetch failed; cancel it manually if still OPEN`);
        continue;
      }
      if (ord.state === "OPEN") {
        // Canceled auths leave VOIDED tenders behind — those never block a
        // cancel attempt. Only a genuinely CAPTURED (COMPLETED) tender does:
        // that means money actually moved and a human must look.
        let captured = false;
        for (const t of (ord.tenders as any[] | undefined) ?? []) {
          if (!t?.payment_id) continue;
          const tPay = await getPaymentRetry(t.payment_id, 2);
          if (tPay?.status === "COMPLETED") {
            captured = true;
            break;
          }
        }
        if (captured) {
          console.log(`  MANUAL ACTION: order ${o.id} (${o.label}) — order has CAPTURED tender — manual review`);
        } else {
          // Same PUT shape as store-credit-probe.mts.
          const r = await sq("PUT", `/orders/${o.id}`, {
            order: { location_id: ord.location_id, version: ord.version, state: "CANCELED" },
          });
          console.log(`  ${o.label}: cancel OPEN order → ${r.ok ? "ok" : "FAILED (no CAPTURED tender — unpaid) " + errStr(r.json)}`);
        }
      } else {
        console.log(`  ${o.label}: state ${ord.state} — nothing to do`);
      }
    } catch (err) {
      console.log(`  MANUAL ACTION: order ${o.id} (${o.label}) — cleanup threw (${String(err)}); cancel it manually if still OPEN`);
    }
  }
  while (cleanupCards.length) {
    const c = cleanupCards.shift()!;
    try {
      await drainAndDeactivate(c.id, c.label);
    } catch (err) {
      console.log(`  MANUAL ACTION: gift card ${c.id} (${c.label}) — cleanup threw (${String(err)}); drain + deactivate manually`);
    }
  }
}

// The moment cleanup() is first invoked (finally block OR a signal/crash
// handler), the main flow must never create another Square object — every
// main-flow mutation site checks this flag and halts.
let bailing = false;
function haltIfBailing(step: string): void {
  if (bailing) throw new Error(`HALT — cleanup already started; skipping ${step}`);
}

async function doCleanup(): Promise<void> {
  console.log("cleanup:");
  try {
    await cleanupPass();
  } catch (err) {
    // cleanupPass fault-isolates every unit; this is the last-resort belt so
    // doCleanup() is structurally unable to throw.
    console.log(`  MANUAL ACTION: cleanup pass threw (${String(err)}) — review the tracked ids printed above`);
  }
}
// Memoized: EVERY caller (finally, SIGINT/SIGTERM, uncaught handlers) awaits
// the SAME in-flight run — no caller can return early and exit mid-cleanup.
let cleanupPromise: Promise<void> | null = null;
function cleanup(): Promise<void> {
  bailing = true;
  return (cleanupPromise ??= doCleanup());
}

// Ctrl-C / kill during the interactive tap wait must still cancel pending
// checkouts + settle everything tracked; a crash must never fall out with
// liabilities behind (exit 1 is never produced — only the deliberate 0/2
// verdicts below). Ids are printed at creation, so even a hard kill leaves
// a manual trail.
const onFatal = (kind: string, err?: unknown) => {
  if (err !== undefined) console.error(`${kind}:`, err);
  else console.log(`\n${kind} — running cleanup, then exiting 2…`);
  void cleanup().then(() => process.exit(2));
};
process.on("SIGINT", () => onFatal("SIGINT"));
process.on("SIGTERM", () => onFatal("SIGTERM"));
process.on("uncaughtException", (err) => onFatal("UNCAUGHT EXCEPTION", err));
process.on("unhandledRejection", (err) => onFatal("UNHANDLED REJECTION", err));

// ── Verdict state ────────────────────────────────────────────────────────────
let gcHoldBehavior = "unknown"; // (a)
let gcCancelVerdict = "unknown"; // (b)
let terminalCancelVerdict = DEVICE ? "unknown" : "not probed (no --device)"; // (c)
let checkoutCancelVerdict = DEVICE ? "unknown" : "not probed (no --device)"; // (d)
let partAConclusive = false;
let partBConclusive = !DEVICE; // no device requested → Part B not required

try {
  // ════════════════════════ PART A — headless ════════════════════════════════
  // ── 1. Funding card + $1 order + APPROVED gift-card auth ───────────────────
  const { mintDigitalGiftCard } = await import("@/lib/square-gift-card");
  const discountId =
    process.env.SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID ||
    process.env.SQUARE_SURVEY_DISCOUNT_CATALOG_ID ||
    "37C3SN4245TUCN3RF7XMNKPU";
  console.log(`1. comp-minting $1 funding card (discount ${discountId})…`);
  haltIfBailing("funding card mint (step 1)");
  const funding = await mintDigitalGiftCard({
    locationId: LOCATION,
    amountCents: AMOUNT,
    baseKey: `${KEY}-fund`,
    discountCatalogObjectId: discountId,
  });
  cleanupCards.push({ id: funding.giftCardId, label: "funding card" });
  console.log(`   funding card ${funding.giftCardId} gan=${maskGan(funding.gan)} $1 ACTIVE`);

  console.log("   creating $1 probe order A…");
  haltIfBailing("order A create");
  const orderARes = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-orderA`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "Approved-Cancel Probe A",
          quantity: "1",
          base_price_money: { amount: AMOUNT, currency: "USD" },
        },
      ],
    },
  });
  if (!orderARes.ok) throw new Error(`order A create failed: ${errStr(orderARes.json)}`);
  const orderAId = orderARes.json.order.id as string;
  ordersToCancel.push({ id: orderAId, label: "order A" });
  console.log(`   order A ${orderAId}`);

  console.log("   CreatePayment(source=gift card, autocomplete:false)…");
  haltIfBailing("GC auth create (payment A)");
  const payABody = {
    idempotency_key: `${KEY}-payA`,
    source_id: funding.giftCardId,
    amount_money: { amount: AMOUNT, currency: "USD" },
    order_id: orderAId,
    location_id: LOCATION,
    autocomplete: false,
  };
  let payARes = await sq("POST", "/payments", payABody);
  if (!payARes.ok && payARes.status === 0) {
    // Network failure — Square may still have created the auth (holding the
    // GC balance). Replay the SAME idempotency key: Square returns the
    // original payment if it exists, recovering the id so cleanup can void it.
    console.log("   ! payment create network-failed — replaying idempotency key to recover the id…");
    payARes = await sq("POST", "/payments", payABody);
  }
  if (!payARes.ok) {
    if (payARes.status === 0) {
      console.log(`   MANUAL: a GC auth with idempotency key ${KEY}-payA may exist — find + cancel it (gift card ${funding.giftCardId})`);
    }
    throw new Error(`gift-card auth failed: ${errStr(payARes.json)}`);
  }
  const payAId = payARes.json.payment.id as string;
  paymentsToResolve.push({ id: payAId, label: "GC auth (A)" });
  const payAStatus = payARes.json.payment.status as string;
  console.log(`   payment ${payAId} status=${payAStatus}`);
  if (payAStatus !== "APPROVED") {
    console.log(`   ! expected APPROVED — got ${payAStatus}; hold/cancel answers below may not apply`);
  }

  // ── 2. Is the GC balance held during the auth? ──────────────────────────────
  console.log("2. GET gift card during auth…");
  let during = await getGiftCard(funding.giftCardId);
  if (!during) {
    // One transient fetch failure must not masquerade as a hold verdict.
    await sleep(2000);
    during = await getGiftCard(funding.giftCardId);
  }
  const balDuring = during?.balance_money?.amount ?? -1;
  gcHoldBehavior = !during
    ? "INCONCLUSIVE — gift card fetch failed during the auth"
    : balDuring === 0
      ? "HELD — balance drops to 0¢ while the auth is APPROVED"
      : balDuring === AMOUNT
        ? "NOT HELD — balance unchanged (100¢) while the auth is APPROVED"
        : `partial/odd — balance ${balDuring}¢ during a ${AMOUNT}¢ auth`;
  console.log(`   balance during auth: ${balDuring === -1 ? "(fetch failed)" : `${balDuring}¢`} → ${gcHoldBehavior}`);
  // (a) must be a definitive HELD / NOT HELD for Part A to count as conclusive.
  const holdConclusive = gcHoldBehavior.startsWith("HELD") || gcHoldBehavior.startsWith("NOT HELD");

  // ── 3. Cancel the APPROVED payment; verify; check balance restored ─────────
  console.log("3. POST /payments/{id}/cancel…");
  haltIfBailing("payment A cancel (step 3)");
  const cancelARes = await sq("POST", `/payments/${payAId}/cancel`, {
    idempotency_key: `${KEY}-cancelA`,
  });
  if (!cancelARes.ok) {
    if (cancelARes.status === 0) {
      // A network drop is NOT a Square rejection — the cancel may or may not
      // have landed. Only a real HTTP rejection is a definitive negative.
      gcCancelVerdict = "INCONCLUSIVE — network failure during cancel";
      console.log(`   ? cancel network-failed: ${errStr(cancelARes.json)}`);
      // partAConclusive stays false
    } else {
      gcCancelVerdict = `FAILED — ${errStr(cancelARes.json)}`;
      console.log(`   ✗ cancel rejected: ${errStr(cancelARes.json)}`);
      // a definitive "no" is still an answer — but (a) must be definitive too
      partAConclusive = payAStatus === "APPROVED" && holdConclusive;
    }
  } else {
    const payAAfter = await getPaymentRetry(payAId);
    console.log(`   payment status after cancel: ${payAAfter?.status}`);
    let after = await getGiftCard(funding.giftCardId);
    let balAfter = after?.balance_money?.amount ?? -1;
    if (balAfter !== AMOUNT) {
      // GC voids are normally instant; give Square one beat before judging.
      await sleep(3000);
      after = await getGiftCard(funding.giftCardId);
      balAfter = after?.balance_money?.amount ?? -1;
    }
    console.log(`   balance before auth: ${AMOUNT}¢ | during auth: ${balDuring}¢ | after cancel: ${balAfter}¢`);
    if (payAAfter?.status === "CANCELED" && balAfter === AMOUNT) {
      gcCancelVerdict = "works — payment CANCELED, balance restored to 100¢";
      partAConclusive = holdConclusive;
      console.log("   ✓ CANCELED + balance restored");
    } else if (payAAfter?.status === "CANCELED") {
      gcCancelVerdict = `payment CANCELED but balance NOT restored (${balAfter}¢)`;
      partAConclusive = holdConclusive;
      console.log("   ! canceled but balance not restored — see verdict");
    } else {
      gcCancelVerdict = `INCONCLUSIVE — cancel 200 but status=${payAAfter?.status}`;
      console.log("   ? cancel accepted but payment not CANCELED");
    }
  }

  // ── 4. Part A cleanup NOW — to completion, BEFORE Part B's interactive tap
  //       wait, so a walk-away or Ctrl-C during the wait leaves nothing from
  //       Part A behind (the guarded final cleanup() then finds it drained). ─
  console.log("4. Part A cleanup:");
  await cleanupPass();

  // ════════════════════════ PART B — terminal (needs --device) ═══════════════
  if (DEVICE) {
    // ── 5. $1 order + terminal checkout autocomplete:false → tap → APPROVED ──
    console.log(`5. creating $1 probe order B + terminal checkout on device ${DEVICE}…`);
    haltIfBailing("order B create (step 5)");
    const orderBRes = await sq("POST", "/orders", {
      idempotency_key: `${KEY}-orderB`,
      order: {
        location_id: LOCATION,
        line_items: [
          {
            name: "Approved-Cancel Probe B",
            quantity: "1",
            base_price_money: { amount: AMOUNT, currency: "USD" },
          },
        ],
      },
    });
    if (!orderBRes.ok) throw new Error(`order B create failed: ${errStr(orderBRes.json)}`);
    const orderBId = orderBRes.json.order.id as string;
    ordersToCancel.push({ id: orderBId, label: "order B" });
    console.log(`   order B ${orderBId}`);

    // Full $1 = the order's net due (the terminal-split probe ruled out partial;
    // full-amount + order_id is the allowed shape). Mirrors createTerminalCheckout
    // in src/features/kiosk/service/square-terminal.ts. Create-with-recovery:
    // a network-failed create replays the idempotency key to recover the id.
    haltIfBailing("checkout B create (step 5)");
    const coBRes = await createTerminalCheckoutRecovering("checkout B", `${KEY}-checkoutB`, {
      device_options: { device_id: DEVICE, skip_receipt_screen: true },
      payment_options: { autocomplete: false },
      order_id: orderBId,
      amount_money: { amount: AMOUNT, currency: "USD" },
      reference_id: `${KEY}-B`.slice(0, 40),
      note: "Approved-cancel probe — auth will be voided, do not capture",
    });
    if (!coBRes.ok) throw new Error(`terminal checkout B failed: ${errStr(coBRes.json)}`);
    const coBId = coBRes.json.checkout.id as string;
    console.log(`   checkout B ${coBId} status=${coBRes.json.checkout.status}`);
    console.log("\x1b[1m   >>> TAP A CARD ON THE READER NOW (the $1 auth will be voided, not captured) <<<\x1b[0m");

    const deadline = Date.now() + 180_000; // 3 minutes for the human tap
    let coB: any = null;
    while (Date.now() < deadline) {
      await sleep(2000);
      coB = await getCheckout(coBId);
      if (coB?.status === "COMPLETED" || coB?.status === "CANCELED") break;
    }
    console.log(`   checkout B final status=${coB?.status ?? "(fetch failed)"} payment_ids=${JSON.stringify(coB?.payment_ids ?? [])}`);

    if (coB?.status !== "COMPLETED" || !coB?.payment_ids?.length) {
      terminalCancelVerdict = `INCONCLUSIVE — checkout ended ${coB?.status ?? "unknown"} (no tap within 180s / canceled on reader)`;
    } else {
      const payBId = coB.payment_ids[0] as string;
      paymentsToResolve.push({ id: payBId, label: "terminal auth (B)" });
      // Retry the GET (2x, 2s apart) — a transient fetch failure must never
      // read as "payment was not APPROVED". Only a real status string is a
      // definitive answer.
      const payB = await getPaymentRetry(payBId);
      console.log(`   payment ${payBId} status=${payB?.status ?? "(fetch failed)"}`);

      // ── 6. Cancel the terminal-created APPROVED payment ────────────────────
      if (!payB) {
        terminalCancelVerdict = "INCONCLUSIVE — payment fetch failed";
        console.log("6. skipped cancel probe — payment fetch failed (cleanup will resolve the auth)");
      } else if (payB.status !== "APPROVED") {
        // A capture despite autocomplete:false is itself a definitive (bad) answer.
        terminalCancelVerdict = `payment was ${payB.status}, not APPROVED — cancel-based sweep NOT viable via terminal`;
        partBConclusive = true;
        console.log(`6. skipped cancel probe — payment not APPROVED (cleanup will resolve it)`);
      } else {
        console.log("6. POST /payments/{id}/cancel on the terminal APPROVED payment…");
        haltIfBailing("payment B cancel (step 6)");
        const cancelBRes = await sq("POST", `/payments/${payBId}/cancel`, {
          idempotency_key: `${KEY}-cancelB`,
        });
        if (!cancelBRes.ok) {
          if (cancelBRes.status === 0) {
            // A network drop is NOT a Square rejection — not a definitive "no".
            terminalCancelVerdict = "INCONCLUSIVE — network failure during cancel";
            console.log(`   ? cancel network-failed: ${errStr(cancelBRes.json)}`);
            // partBConclusive stays false
          } else {
            terminalCancelVerdict = `FAILED — ${errStr(cancelBRes.json)}`;
            partBConclusive = true; // definitive "no" — a real HTTP rejection from Square
            console.log(`   ✗ cancel rejected: ${errStr(cancelBRes.json)}`);
          }
        } else {
          const payBAfter = await getPaymentRetry(payBId);
          console.log(`   payment status after cancel: ${payBAfter?.status ?? "(fetch failed)"}`);
          if (payBAfter?.status === "CANCELED") {
            terminalCancelVerdict = "works — terminal APPROVED auth voided via /payments/{id}/cancel";
            partBConclusive = true;
            console.log("   ✓ CANCELED — the sweep can void abandoned reader auths");
          } else {
            terminalCancelVerdict = `INCONCLUSIVE — cancel 200 but status=${payBAfter?.status}`;
          }
        }
      }
    }

    // ── 7. PENDING checkout cancel (no tap, amount-only → no order created) ──
    console.log("7. creating a second checkout and canceling it while PENDING (do NOT tap)…");
    haltIfBailing("checkout C create (step 7)");
    const coCRes = await createTerminalCheckoutRecovering("checkout C", `${KEY}-checkoutC`, {
      device_options: { device_id: DEVICE, skip_receipt_screen: true },
      payment_options: { autocomplete: false },
      amount_money: { amount: AMOUNT, currency: "USD" },
      reference_id: `${KEY}-C`.slice(0, 40),
      note: "Approved-cancel probe — canceled before any tap",
    });
    if (!coCRes.ok) {
      checkoutCancelVerdict = `INCONCLUSIVE — checkout C create failed: ${errStr(coCRes.json)}`;
      console.log(`   ✗ checkout C create failed: ${errStr(coCRes.json)}`);
    } else {
      const coCId = coCRes.json.checkout.id as string;
      console.log(`   checkout C ${coCId} status=${coCRes.json.checkout.status} — canceling now`);
      haltIfBailing("checkout C cancel (step 7)");
      const cancelCRes = await sq("POST", `/terminals/checkouts/${coCId}/cancel`, {});
      if (!cancelCRes.ok) {
        if (cancelCRes.status === 0) {
          // A network drop is NOT a Square rejection — not a definitive "no".
          checkoutCancelVerdict = "INCONCLUSIVE — network failure during cancel";
          console.log(`   ? checkout cancel network-failed: ${errStr(cancelCRes.json)}`);
        } else {
          checkoutCancelVerdict = `FAILED — ${errStr(cancelCRes.json)}`;
          console.log(`   ✗ checkout cancel rejected: ${errStr(cancelCRes.json)}`);
        }
      } else {
        // CANCEL_REQUESTED → CANCELED can take a beat while the reader disarms.
        let coC: any = cancelCRes.json.checkout ?? null;
        const cDeadline = Date.now() + 30_000;
        while (coC?.status !== "CANCELED" && Date.now() < cDeadline) {
          await sleep(2000);
          coC = await getCheckout(coCId);
        }
        const hadPayment = (coC?.payment_ids?.length ?? 0) > 0;
        console.log(`   checkout C status=${coC?.status} payment_ids=${JSON.stringify(coC?.payment_ids ?? [])}`);
        if (coC?.status === "CANCELED") {
          checkoutCancelVerdict = `works — PENDING checkout → CANCELED; payment object ${hadPayment ? "EXISTED (unexpected — check cleanup)" : "never existed"}`;
          console.log(`   ✓ CANCELED — payment object ${hadPayment ? "existed" : "never existed"}`);
          if (hadPayment) {
            for (const pid of coC.payment_ids as string[]) {
              paymentsToResolve.push({ id: pid, label: "checkout C stray payment" });
            }
          }
        } else {
          checkoutCancelVerdict = `INCONCLUSIVE — stuck at ${coC?.status} after 30s`;
          partBConclusive = false;
        }
      }
    }
    // ANY verdict containing INCONCLUSIVE (wherever it appears) makes Part B
    // non-conclusive — this recompute must never override an earlier
    // inconclusive marking with true.
    if (terminalCancelVerdict.includes("INCONCLUSIVE") || checkoutCancelVerdict.includes("INCONCLUSIVE")) {
      partBConclusive = false;
    } else if (terminalCancelVerdict !== "unknown" && checkoutCancelVerdict !== "unknown") {
      partBConclusive = true;
    }
  }
} catch (err) {
  console.error("PROBE ERROR:", err instanceof Error ? err.message : err);
} finally {
  // ── 8. Final cleanup — runs on EVERY path. cleanup() is memoized (every
  //       caller awaits the SAME run) and fault-isolates every unit (it is
  //       structurally unable to throw), so the VERDICT below always prints. ─
  await cleanup();
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log("");
console.log(`  (a) GC balance during auth:        ${gcHoldBehavior}`);
console.log(`  (b) payment-cancel on GC auth:     ${gcCancelVerdict}`);
console.log(`  (c) payment-cancel on terminal:    ${terminalCancelVerdict}`);
console.log(`  (d) checkout-cancel (pre-tap):     ${checkoutCancelVerdict}`);
const conclusive = partAConclusive && partBConclusive;
console.log(`\nVERDICT: ${conclusive ? "CONCLUSIVE" : "INCONCLUSIVE"} — see (a)–(d) above`);
process.exit(conclusive ? 0 : 2);
