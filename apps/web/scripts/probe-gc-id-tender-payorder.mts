/**
 * $0 live probe: does a gift-card ID (`gftc:…`) work as `source_id` with
 * `autocomplete: false` + `order_id` — and can TWO such auths on one order be
 * captured atomically via PayOrder?
 *
 * Why: `authorizeMultiTender` (lib/square-gift-card.ts) proves GC+card mixing
 * in prod, but with GC *nonces* from the Web Payments SDK. Id-as-source is
 * prod-proven only with `autocomplete: true` single-tender (store-credit-probe).
 * The kiosk split-tender path needs the missing combination: id-as-source in
 * the auth (autocomplete:false) + PayOrder shape, with MULTIPLE gift-card
 * auths captured together.
 *
 * Sequence (all against the live production account; comp-minted funds only,
 * total real-money exposure $0):
 *   1. Comp-mint funding GC #1, $1.00 DIGITAL (mintDigitalGiftCard — the same
 *      prod-proven comp path survey rewards use).
 *   2. Comp-mint funding GC #2, $1.00.
 *   3. Create an order with one $2.00 ad-hoc line "GC tender probe".
 *   4. CreatePayment #1: source_id = <gftc id #1>, $1.00, order_id,
 *      autocomplete:false  ← THE PROBED CALL. Expect APPROVED.
 *   5. CreatePayment #2: same with GC #2. Expect APPROVED.
 *   6. Sanity GET both gift cards — print balances while the auths are pending
 *      (informational: does an APPROVED auth hold GC balance?).
 *   7. PayOrder [both payment ids] (no order_version). Expect order COMPLETED
 *      and both payments COMPLETED → PASS.
 *   8. Negative-confirm (informational): CreatePayment with source_id = the raw
 *      GAN of GC #1 ($1.00, NO order, autocomplete:false) — expect the
 *      documented BAD_REQUEST (re-confirms GAN-as-source fails). Cancelled
 *      immediately if it unexpectedly succeeds. Does not change the verdict.
 *   9. Cleanup (finally — runs on EVERY path): cancel any APPROVED-but-not-
 *      captured payments; cancel the order if it never got paid; drain
 *      (ADJUST_DECREMENT) + deactivate BOTH gift cards. If the capture
 *      succeeded, the order stays COMPLETED with comp funds — books show a
 *      $2 comp sale, same precedent as store-credit-probe — and both GCs are
 *      already empty (funds moved to the order), so they are just deactivated.
 *      No refunds by design (comp money; a refund would only re-fund a card
 *      we are about to drain). No hardware → no terminal checkouts to cancel.
 *      Zero liabilities left either way.
 *
 * Exit codes:
 *   0 — PASS: both id-sourced auths APPROVED and PayOrder captured them
 *       atomically (order COMPLETED, both payments COMPLETED). Also exits 0
 *       on a dry run.
 *   1 — FAIL (deliberate verdict ONLY): Square definitively rejected
 *       id-as-source under autocomplete:false (400 with INVALID_VALUE /
 *       BAD_REQUEST / "Invalid source_id"), or the capture verifiably did not
 *       complete — the kiosk split-tender design cannot use this shape.
 *   2 — INCONCLUSIVE / aborted: transient Square errors (429/5xx/network),
 *       verification GETs still failing after retries, missing .env.local,
 *       SIGINT/SIGTERM, or an uncaught exception/rejection. Cleanup still ran
 *       (every unit fault-isolated; failures print "MANUAL ACTION" lines) —
 *       read the log, then re-run the probe.
 *
 * Run from apps/web:  npx tsx scripts/probe-gc-id-tender-payorder.mts [--location <id>] [--live]
 * DRY RUN by default (prints the exact plan). Pass --live to execute.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
let envLocal: string;
try {
  envLocal = readFileSync(".env.local", "utf8");
} catch {
  console.error("Cannot read .env.local — run from apps/web (needs .env.local)");
  process.exit(2);
}
for (const line of envLocal.split(/\r?\n/)) {
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

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return process.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const LOCATION = argValue("--location") || "LAB52GY480CJF"; // FastTrax Fort Myers (kiosk-reader venue)
const AMOUNT_EACH = 100; // $1.00 per funding card / per auth
const ORDER_TOTAL = 200; // $2.00 order line
const KEY = `probe-${randomUUID().slice(0, 8)}`;

console.log(`\x1b[1m*** PRODUCTION Square account — location ${LOCATION} ***\x1b[0m`);

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Would: 1. comp-mint $1 funding GC #1 @ ${LOCATION} (mintDigitalGiftCard, baseKey ${KEY}-f1)`);
  console.log(`Would: 2. comp-mint $1 funding GC #2 (baseKey ${KEY}-f2)`);
  console.log('Would: 3. POST /orders — one $2.00 ad-hoc line "GC tender probe"');
  console.log("Would: 4. POST /payments — source_id=<gftc id #1>, $1.00, order_id, autocomplete:false ← probed");
  console.log("Would: 5. POST /payments — source_id=<gftc id #2>, $1.00, order_id, autocomplete:false");
  console.log("Would: 6. GET /gift-cards/{id} ×2 — balances while auths pending (informational)");
  console.log("Would: 7. POST /orders/{id}/pay — payment_ids=[#1,#2] (no order_version) ← multi-auth capture");
  console.log("Would: 8. POST /payments — source_id=<raw GAN of GC #1>, $1.00, no order (expect BAD_REQUEST; informational)");
  console.log("Would: 9. cleanup — cancel un-captured payments, cancel unpaid order, drain + deactivate both GCs");
  process.exit(0);
}

// Searchable trail even if this process is killed mid-run: the run key and the
// deterministic mint baseKeys are printed BEFORE any Square call is made.
console.log(`=== LIVE RUN — KEY=${KEY}; mint baseKeys: gc-mint-${KEY}-f1, gc-mint-${KEY}-f2 ===`);

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: H,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // A Square call must NEVER throw — network faults come back as a normal
    // error-shaped result so probe steps and cleanup stay on their rails.
    return { ok: false, status: 0, json: { errors: [{ code: "NETWORK", detail: String(err) }] } };
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  const ok = res.ok && !(json?.errors?.length > 0);
  return { ok, status: res.status, json };
}

// Never log a full GAN — every logged error body passes through here.
const secretGans: string[] = [];
function redact(s: string): string {
  let out = s;
  for (const g of secretGans) if (g) out = out.split(g).join(`${g.slice(0, 2)}…${g.slice(-4)}`);
  return out;
}
function errText(json: any): string {
  return redact(JSON.stringify(json?.errors ?? json ?? null)).slice(0, 400);
}

// A rejection is a design verdict ONLY when Square says 400 with a
// source-shaped error. 429 / 5xx / network / anything unexpected is transient
// noise, not proof the shape is unsupported.
function rejectionVerdict(status: number, json: any): "fail" | "inconclusive" {
  if (status !== 400) return "inconclusive";
  const errs: any[] = json?.errors ?? [];
  const definitive = errs.some(
    (e) =>
      e?.code === "INVALID_VALUE" ||
      e?.code === "BAD_REQUEST" ||
      /invalid source_id/i.test(String(e?.detail ?? "")),
  );
  return definitive ? "fail" : "inconclusive";
}

// The mint lib logs the FULL GAN on success ("mint activated … gan=…"), before
// this script can register it for redaction. Patch console.log around each
// mint so any GAN-shaped token (12+ alphanumerics) is masked to first2+last4,
// then restore.
function maskGanShaped(s: string): string {
  return s.replace(/[A-Za-z0-9]{12,}/g, (m) => `${m.slice(0, 2)}…${m.slice(-4)}`);
}
async function mintMasked<T>(mint: (opts: any) => Promise<T>, opts: any): Promise<T> {
  const orig = console.log;
  console.log = (...args: unknown[]) =>
    orig(...args.map((a) => (typeof a === "string" ? maskGanShaped(a) : a)));
  try {
    return await mint(opts);
  } finally {
    console.log = orig;
  }
}

// Each step (drain, deactivate) is fault-isolated: a failure on one card, or
// on one step, never skips the rest — it prints a MANUAL ACTION line instead.
async function drainAndDeactivate(giftCardId: string, label: string): Promise<void> {
  const gc = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
  if (!gc) {
    console.log(`  MANUAL ACTION: gift card ${giftCardId} (${label}) — fetch failed; drain + deactivate it manually`);
    return;
  }
  try {
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
      console.log(`  cleanup ${label}: drained ${bal}¢ → ${r.ok ? "ok" : "FAILED " + errText(r.json)}`);
      if (!r.ok) {
        console.log(`  MANUAL ACTION: gift card ${giftCardId} (${label}) — drain failed; check its balance manually`);
      }
    } else {
      console.log(`  cleanup ${label}: balance ${bal}¢ state=${gc.state} — no drain needed`);
    }
  } catch (err) {
    console.log(
      `  MANUAL ACTION: gift card ${giftCardId} (${label}) — drain threw (${redact(String(err))}); check its balance manually`,
    );
  }
  try {
    const state = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.state;
    if (state === "ACTIVE") {
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
      console.log(`  cleanup ${label}: deactivate → ${r.ok ? "ok" : "FAILED " + errText(r.json)}`);
      if (!r.ok) {
        console.log(`  MANUAL ACTION: gift card ${giftCardId} (${label}) — deactivate failed; deactivate it manually`);
      }
    }
  } catch (err) {
    console.log(
      `  MANUAL ACTION: gift card ${giftCardId} (${label}) — deactivate threw (${redact(String(err))}); deactivate it manually`,
    );
  }
}

// Every created object is tracked HERE, immediately on creation, BEFORE the
// next Square call — cleanup() below is the single cleanup authority (invoked
// from the finally block, SIGINT/SIGTERM, and the crash handlers).
const cleanupCards: Array<{ id: string; label: string }> = [];
const paymentsToCancel: Array<{ id: string; label: string }> = [];
let orderIdToCancel: string | null = null;
let captured = false;
let verdict: "pass" | "fail" | "inconclusive" = "inconclusive";

// ── Single cleanup authority — called from the finally block, signal handlers,
//    and crash handlers. Memoized promise: EVERY caller awaits the SAME
//    in-flight run, so no path can exit mid-cleanup. doCleanup() itself is
//    structurally unable to throw (sq() never throws, and every per-object
//    unit has its own try/catch that prints a MANUAL ACTION line and
//    continues). ──────────────────────────────────────────────────────────────
let cleanupPromise: Promise<void> | null = null;
function cleanup(): Promise<void> {
  return (cleanupPromise ??= doCleanup());
}
async function doCleanup(): Promise<void> {
  console.log("9. cleanup:");
  // a) Void any APPROVED-but-uncaptured auths (Square auto-voids in ~6 days,
  //    but we don't leave that dangling).
  for (const p of paymentsToCancel) {
    try {
      const r = await sq("POST", `/payments/${p.id}/cancel`, {
        idempotency_key: `${KEY}-cancel-${p.id.slice(-6)}`,
      });
      console.log(`  ${p.label} ${p.id} cancel → ${r.ok ? "ok" : "FAILED " + errText(r.json)}`);
      if (!r.ok) {
        console.log(`  MANUAL ACTION: payment ${p.id} — verify it shows CANCELED/voided in the Square dashboard`);
      }
    } catch (err) {
      console.log(
        `  MANUAL ACTION: payment ${p.id} — cancel threw (${redact(String(err))}); verify it in the Square dashboard`,
      );
    }
  }
  // b) Cancel the order if it never got paid (fresh version from a GET, per
  //    the store-credit-probe precedent). Voided/cancelled tenders do NOT
  //    block a cancel attempt — only a COMPLETED (captured) tender does, and
  //    that case is flagged for manual review, never claimed as "no liability".
  if (orderIdToCancel) {
    try {
      const o = (await sq("GET", `/orders/${orderIdToCancel}`)).json?.order;
      if (o && o.state === "OPEN") {
        let hasCapturedTender = false;
        let tenderStatusUnverified = false;
        for (const t of o.tenders ?? []) {
          if (!t?.payment_id) continue;
          const stRes = await sq("GET", `/payments/${t.payment_id}`);
          const st = stRes.json?.payment?.status;
          if (!stRes.ok || !st) tenderStatusUnverified = true;
          if (st === "COMPLETED") hasCapturedTender = true;
        }
        if (hasCapturedTender) {
          console.log(`  order has CAPTURED tender — manual review`);
          console.log(`  MANUAL ACTION: order ${orderIdToCancel} — a tender is COMPLETED; review it in the Square dashboard (cancel skipped)`);
        } else {
          const r = await sq("PUT", `/orders/${orderIdToCancel}`, {
            order: { location_id: o.location_id, version: o.version, state: "CANCELED" },
          });
          console.log(
            `  probe order cancelled → ${
              r.ok
                ? "ok"
                : "FAILED " +
                  errText(r.json) +
                  (tenderStatusUnverified
                    ? ` (tender status unverified — check order ${orderIdToCancel} manually)`
                    : " (no COMPLETED tender on the OPEN order = no liability; note for manual check)")
            }`,
          );
          if (!r.ok) {
            console.log(`  MANUAL ACTION: order ${orderIdToCancel} — cancel failed; verify its state in the Square dashboard`);
          }
        }
      } else if (!o) {
        console.log(`  MANUAL ACTION: order ${orderIdToCancel} — state fetch failed; check it in the Square dashboard`);
      } else {
        console.log(`  probe order state=${o.state} — no cancel applicable`);
      }
    } catch (err) {
      console.log(
        `  MANUAL ACTION: order ${orderIdToCancel} — cancel path threw (${redact(String(err))}); check it in the Square dashboard`,
      );
    }
  } else if (captured) {
    console.log(
      "  order captured & COMPLETED with comp funds — books show a $2 comp sale (matches store-credit-probe precedent); left as-is by design",
    );
  }
  // c) Drain + deactivate every card this probe minted — after payment cancels,
  //    so any auth-held balance has been released back to the card first. A
  //    failure on GC #1 must never skip GC #2.
  for (const c of cleanupCards) {
    try {
      await drainAndDeactivate(c.id, c.label);
    } catch (err) {
      console.log(
        `  MANUAL ACTION: gift card ${c.id} (${c.label}) — drain/deactivate threw (${redact(String(err))}); drain + deactivate it manually`,
      );
    }
  }
}

// ── Abort/crash rails: cleanup always gets its chance, then exit 2 — exit 1
//    is reachable ONLY as the deliberate FAIL verdict at the bottom. ─────────
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} received — running cleanup, then exiting 2…`);
    void cleanup()
      .catch((err) => console.error("cleanup error:", err instanceof Error ? redact(err.message) : err))
      .finally(() => process.exit(2));
  });
}
for (const evt of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(evt, (err) => {
    console.error(`${evt}:`, err instanceof Error ? redact(err.message) : err);
    void cleanup()
      .catch((e) => console.error("cleanup error:", e instanceof Error ? redact(e.message) : e))
      .finally(() => process.exit(2));
  });
}

try {
  // ── 1 & 2. Comp-mint the two $1 funding cards ─────────────────────────────
  const { mintDigitalGiftCard } = await import("@/lib/square-gift-card");
  const discountId =
    process.env.SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID ||
    process.env.SQUARE_SURVEY_DISCOUNT_CATALOG_ID ||
    "37C3SN4245TUCN3RF7XMNKPU";

  console.log(`1. comp-minting $1 funding GC #1 (discount ${discountId})…`);
  let gc1: Awaited<ReturnType<typeof mintDigitalGiftCard>>;
  try {
    gc1 = await mintMasked(mintDigitalGiftCard, {
      locationId: LOCATION,
      amountCents: AMOUNT_EACH,
      baseKey: `${KEY}-f1`,
      discountCatalogObjectId: discountId,
    });
  } catch (err) {
    console.error(
      `   POSSIBLE UNTRACKED CARD — check Square dashboard for keys gc-mint-${KEY}-f1 / gc-act-${KEY}-f1 (and gc-order-/gc-pay- siblings)`,
    );
    throw err;
  }
  secretGans.push(gc1.gan); // register for redaction IMMEDIATELY, before any other log line
  cleanupCards.push({ id: gc1.giftCardId, label: "funding GC #1" });
  console.log(`   GC #1 ${gc1.giftCardId} gan=${gc1.gan.slice(0, 2)}…${gc1.gan.slice(-4)} $1 ACTIVE — tracked for cleanup`);

  console.log("2. comp-minting $1 funding GC #2…");
  let gc2: Awaited<ReturnType<typeof mintDigitalGiftCard>>;
  try {
    gc2 = await mintMasked(mintDigitalGiftCard, {
      locationId: LOCATION,
      amountCents: AMOUNT_EACH,
      baseKey: `${KEY}-f2`,
      discountCatalogObjectId: discountId,
    });
  } catch (err) {
    console.error(
      `   POSSIBLE UNTRACKED CARD — check Square dashboard for keys gc-mint-${KEY}-f2 / gc-act-${KEY}-f2 (and gc-order-/gc-pay- siblings)`,
    );
    throw err;
  }
  secretGans.push(gc2.gan); // register for redaction IMMEDIATELY
  cleanupCards.push({ id: gc2.giftCardId, label: "funding GC #2" });
  console.log(`   GC #2 ${gc2.giftCardId} gan=${gc2.gan.slice(0, 2)}…${gc2.gan.slice(-4)} $1 ACTIVE — tracked for cleanup`);

  // ── 3. $2 ad-hoc-line order ────────────────────────────────────────────────
  console.log('3. creating $2.00 order (ad-hoc line "GC tender probe")…');
  const orderRes = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-order`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "GC tender probe",
          quantity: "1",
          base_price_money: { amount: ORDER_TOTAL, currency: "USD" },
        },
      ],
    },
  });
  if (!orderRes.ok) throw new Error(`order create failed: ${errText(orderRes.json)}`);
  const orderId = orderRes.json.order.id as string;
  orderIdToCancel = orderId;
  console.log(`   order ${orderId} total=${orderRes.json.order.total_money?.amount}¢ — tracked for cleanup`);

  // ── 4. THE PROBED CALL — gftc id as source_id, autocomplete:false + order ─
  console.log("4. CreatePayment #1 (source_id = gftc id #1, autocomplete:false, order_id)…");
  const pay1Res = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-pay1`,
    source_id: gc1.giftCardId,
    amount_money: { amount: AMOUNT_EACH, currency: "USD" },
    order_id: orderId,
    location_id: LOCATION,
    autocomplete: false,
  });
  if (!pay1Res.ok) {
    verdict = rejectionVerdict(pay1Res.status, pay1Res.json);
    console.log(
      verdict === "fail"
        ? "   ✗ REJECTED — gift-card ID is not accepted as source_id with autocomplete:false."
        : `   ? auth #1 failed with a transient/unexpected error (HTTP ${pay1Res.status}) — inconclusive, not a design verdict.`,
    );
    console.log(`   error: ${errText(pay1Res.json)}`);
    throw new Error("id-as-source auth #1 rejected");
  }
  const pay1 = pay1Res.json.payment;
  paymentsToCancel.push({ id: pay1.id, label: "auth #1" });
  console.log(`   ✓ payment ${pay1.id} status=${pay1.status} — tracked for cleanup`);
  if (pay1.status !== "APPROVED") {
    // 2xx with a status that is neither APPROVED nor a 400-source rejection
    // (e.g. PENDING) is not proof the shape is unsupported — inconclusive.
    verdict = "inconclusive";
    console.log(`   ? auth #1 returned 2xx with status ${pay1.status} (wanted APPROVED) — inconclusive, not a design verdict.`);
    throw new Error(`auth #1 unexpected status ${pay1.status} (wanted APPROVED)`);
  }

  // ── 5. Second id-sourced auth on the SAME order ────────────────────────────
  console.log("5. CreatePayment #2 (source_id = gftc id #2, same order)…");
  const pay2Res = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-pay2`,
    source_id: gc2.giftCardId,
    amount_money: { amount: AMOUNT_EACH, currency: "USD" },
    order_id: orderId,
    location_id: LOCATION,
    autocomplete: false,
  });
  if (!pay2Res.ok) {
    verdict = rejectionVerdict(pay2Res.status, pay2Res.json);
    console.log(
      verdict === "fail"
        ? "   ✗ REJECTED — second id-sourced auth on the same order refused."
        : `   ? auth #2 failed with a transient/unexpected error (HTTP ${pay2Res.status}) — inconclusive, not a design verdict.`,
    );
    console.log(`   error: ${errText(pay2Res.json)}`);
    throw new Error("id-as-source auth #2 rejected");
  }
  const pay2 = pay2Res.json.payment;
  paymentsToCancel.push({ id: pay2.id, label: "auth #2" });
  console.log(`   ✓ payment ${pay2.id} status=${pay2.status} — tracked for cleanup`);
  if (pay2.status !== "APPROVED") {
    // Same rule as auth #1: 2xx non-APPROVED (e.g. PENDING) → inconclusive.
    verdict = "inconclusive";
    console.log(`   ? auth #2 returned 2xx with status ${pay2.status} (wanted APPROVED) — inconclusive, not a design verdict.`);
    throw new Error(`auth #2 unexpected status ${pay2.status} (wanted APPROVED)`);
  }

  // ── 6. Balance sanity while auths are pending (informational) ─────────────
  console.log("6. GC balances while both auths are APPROVED (does an auth hold GC balance?)…");
  for (const [label, id] of [
    ["GC #1", gc1.giftCardId],
    ["GC #2", gc2.giftCardId],
  ] as const) {
    const g = (await sq("GET", `/gift-cards/${id}`)).json?.gift_card;
    console.log(`   ${label}: state=${g?.state} balance=${g?.balance_money?.amount}¢`);
  }

  // ── 7. Atomic multi-auth capture via PayOrder ──────────────────────────────
  console.log("7. PayOrder — capturing both auths atomically…");
  const payOrderRes = await sq("POST", `/orders/${orderId}/pay`, {
    idempotency_key: `${KEY}-payorder`,
    payment_ids: [pay1.id, pay2.id],
  });
  if (!payOrderRes.ok) {
    verdict = rejectionVerdict(payOrderRes.status, payOrderRes.json);
    console.log(
      verdict === "fail"
        ? "   ✗ PayOrder REJECTED — multi-auth capture of id-sourced GC payments failed."
        : `   ? PayOrder failed with a transient/unexpected error (HTTP ${payOrderRes.status}) — inconclusive, not a design verdict.`,
    );
    console.log(`   error: ${errText(payOrderRes.json)}`);
    throw new Error("PayOrder failed");
  }
  let finalOrderState: string | undefined = payOrderRes.json?.order?.state;
  console.log(`   ✓ PayOrder ok — order state=${finalOrderState ?? "(missing — re-reading)"}`);
  for (let attempt = 0; attempt < 2 && !finalOrderState; attempt++) {
    finalOrderState = (await sq("GET", `/orders/${orderId}`)).json?.order?.state;
  }
  if (finalOrderState === "COMPLETED") {
    // The capture is real the moment the order is COMPLETED — release the
    // cleanup trackers NOW so a flaky verification GET below can never make
    // cleanup try to cancel captured payments or the paid order.
    captured = true;
    paymentsToCancel.length = 0; // captured — nothing to cancel
    orderIdToCancel = null; // paid — no cancel possible or needed
  }
  // Verification GETs: a failed read after a successful PayOrder is not
  // evidence of a failed capture — retry twice, and if a status still can't
  // be read the verdict is INCONCLUSIVE, never FAIL.
  const paymentStatus = async (payId: string): Promise<string | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = (await sq("GET", `/payments/${payId}`)).json?.payment?.status;
      if (s) return s;
    }
    return null;
  };
  const p1After = await paymentStatus(pay1.id);
  const p2After = await paymentStatus(pay2.id);
  console.log(`   payment #1=${p1After ?? "GET failed ×3"} payment #2=${p2After ?? "GET failed ×3"}`);
  if (finalOrderState === "COMPLETED" && p1After === "COMPLETED" && p2After === "COMPLETED") {
    verdict = "pass";
  } else if (!finalOrderState || p1After === null || p2After === null) {
    verdict = "inconclusive";
    console.log("   ? verification reads kept failing — capture state unknown; re-run the probe");
  } else {
    verdict = "fail";
    console.log("   ✗ capture incomplete — see states above");
  }
  // Do NOT throw yet: fall through to the negative-confirm, cleanup runs regardless.

  // ── 8. Negative-confirm: raw GAN as source_id (informational only) ────────
  console.log("8. negative-confirm — CreatePayment with source_id = raw GAN of GC #1 (no order)…");
  const negRes = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-neg`,
    source_id: gc1.gan,
    amount_money: { amount: AMOUNT_EACH, currency: "USD" },
    location_id: LOCATION,
    autocomplete: false,
  });
  if (!negRes.ok) {
    const code = negRes.json?.errors?.[0]?.code ?? "";
    console.log(`   ✓ rejected as expected (HTTP ${negRes.status}): ${errText(negRes.json)}`);
    if (/INSUFFICIENT/i.test(code)) {
      console.log(
        "   ! NOTE: the failure was balance-shaped, not source-shaped — Square may have ACCEPTED the GAN as a source. Investigate.",
      );
    }
  } else {
    // Unexpected: GAN worked as a source. Track + cancel immediately.
    const negPay = negRes.json.payment;
    paymentsToCancel.push({ id: negPay.id, label: "negative-confirm auth" });
    console.log(
      `   ! UNEXPECTED: GAN-as-source succeeded (payment ${negPay.id} status=${negPay.status}) — cancelling immediately`,
    );
    const c = await sq("POST", `/payments/${negPay.id}/cancel`, {
      idempotency_key: `${KEY}-negcancel`,
    });
    if (c.ok) {
      console.log("   cancelled ok");
      paymentsToCancel.splice(
        paymentsToCancel.findIndex((p) => p.id === negPay.id),
        1,
      );
    } else {
      console.log(`   cancel FAILED (${errText(c.json)}) — finally block will retry`);
    }
  }

  if (verdict !== "pass") {
    throw new Error(
      verdict === "inconclusive"
        ? "capture could not be verified (see step 7) — inconclusive"
        : "capture verification failed (see step 7)",
    );
  }
} catch (err) {
  console.error("PROBE ERROR:", err instanceof Error ? redact(err.message) : err);
} finally {
  try {
    await cleanup();
  } catch (err) {
    // cleanup() is written to never throw — this belt-and-suspenders catch is
    // the structural guarantee that the VERDICT print + exit below always run.
    console.error("CLEANUP ERROR:", err instanceof Error ? redact(err.message) : err);
  }
}

console.log(`\nVERDICT: ${verdict.toUpperCase()}`);
if (verdict === "pass") {
  console.log(
    "→ gftc-id-as-source works with autocomplete:false + order_id, and PayOrder captures multiple such auths atomically.",
  );
  process.exit(0);
} else if (verdict === "inconclusive") {
  console.log(
    "→ no design verdict — a transient/unexpected error interrupted the probe (cleanup ran; check any MANUAL ACTION lines above). Re-run the probe.",
  );
  process.exit(2);
} else {
  console.log(
    "→ do NOT build the kiosk split-tender on id-as-source auth + PayOrder; use GC nonces (authorizeMultiTender shape) instead.",
  );
  process.exit(1);
}
