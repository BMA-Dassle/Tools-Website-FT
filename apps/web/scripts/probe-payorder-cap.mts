/**
 * $0-exposure live probe: what is the REAL per-order tender cap for PayOrder
 * (POST /v2/orders/{id}/pay), and does VERSION-LESS PayOrder capture cleanly
 * at exactly N = cap?
 *
 * Square documents "up to 10" payments per order but we have never proven
 * WHERE the boundary is enforced — CreatePayment attach-time (or a concurrent
 * auths-per-gift-card limit) vs PayOrder capture-time — nor that a PayOrder
 * with no order_version works at the cap. This settles both and yields the
 * constant SQUARE_MAX_TENDERS_PER_ORDER.
 *
 * Sequence (all comp funds — $0 real-money exposure):
 *   1. Comp-mint ONE $<max> DIGITAL funding gift card (mintDigitalGiftCard,
 *      the prod-proven survey-reward path). If the mint throws mid-flight it
 *      prints the deterministic idempotency keys its 4 Square calls used
 *      (gc-order/gc-pay/gc-mint/gc-act-<key>-fund) as a manual trail.
 *   2. Create an order with one ad-hoc "Cap probe" line of $<max>.00.
 *   3. Authorize $1 payments #1..max against it (source_id = the funding GC,
 *      autocomplete:false). A failure here is an auth-time boundary ONLY when
 *      the error is a per-ORDER payment-count error; INSUFFICIENT_FUNDS /
 *      per-gift-card / ambiguous errors are printed verbatim and end exit 2.
 *   4. PayOrder with ALL successful auth ids — deliberately NO order_version.
 *      A count-related error here = the capture-time boundary, printed
 *      verbatim. (When the auth loop already stopped short, PayOrder on the
 *      $max order is SKIPPED — fewer payments than the total would only
 *      produce an amount-mismatch error, not a cap signal.) Every successful
 *      PayOrder is verified with a GET — order state=COMPLETED and tender
 *      count = payment count — before it counts as proven.
 *   5. Pinning requires BOTH signals observed live (never error text alone):
 *      PayOrder SUCCESS at N = cap AND a count-FAILURE at N = cap+1. Cancel
 *      every probe auth to free the GC; when the failing run was not already
 *      at cap+1, first run the DISPROOF (fresh order sized (cap+1)×$1 —
 *      PayOrder must fail count-related), then the PROOF (fresh order sized
 *      cap×$1 — version-less PayOrder must capture cleanly).
 *   6. Cleanup — extracted into cleanup(), run from the finally block AND from
 *      SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers (ran-once
 *      guard). Every per-object step is fault-isolated: a failure prints
 *      "MANUAL ACTION: …" and moves on, so the VERDICT always prints. Steps:
 *      cancel every un-captured auth (POST /payments/{id}/cancel), FULL-refund
 *      every captured $1 payment (POST /refunds — full refunds of GC-funded
 *      payments are allowed, so the money flows back onto the funding GC),
 *      cancel unpaid orders (an OPEN order whose tenders are all voided still
 *      gets a cancel attempt; a genuinely CAPTURED tender is flagged for
 *      manual review instead), re-poll the GC balance whenever cleanup issued
 *      cancels/refunds (target accounts for captured-but-unrefunded money),
 *      then drain (ADJUST_DECREMENT, reason PURCHASE_WAS_REFUNDED) +
 *      deactivate (DEACTIVATE, reason SUSPICIOUS_ACTIVITY — the only enum
 *      Square accepts) the funding gift card, with a post-deactivate balance
 *      re-check that warns loudly if any money is stranded. This probe
 *      creates no terminal checkouts, so none need cancelling.
 *
 * Exit codes:
 *   0 → a definitive cap was PINNED: version-less capture proven at exactly
 *       N = cap AND a count-failure observed live at N = cap+1 → set
 *       SQUARE_MAX_TENDERS_PER_ORDER to the printed value
 *   2 → anything else: no boundary up to --max (re-run with a higher --max);
 *       an ambiguous/non-count error (for auth-loop failures: diversify
 *       funding across 2 gift cards to separate per-GC limits from the order
 *       cap); a cap that could not be pinned (missing the cap+1 disproof); a
 *       failed capture proof or a post-capture verification mismatch (order
 *       not COMPLETED / tender count off — raw order JSON printed); a missing
 *       .env.local (run from apps/web); an interrupted (SIGINT/SIGTERM) or
 *       crashed run — cleanup still runs first; or any other probe error.
 *       Read the verbatim Square errors above the verdict and re-run.
 *
 * DRY RUN by default — prints the exact plan and exits 0. Pass --live to run.
 * Args: --location <id> (default LAB52GY480CJF, FastTrax Fort Myers — the
 *       kiosk-reader venue) · --max <n> (default 11; recommended first run —
 *       expect PayOrder(11) to fail, then the internal proof run pins cap=10)
 * Run:  npx tsx scripts/probe-payorder-cap.mts [--live] [--max 11] [--location <id>]
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
let envRaw = "";
try {
  envRaw = readFileSync(".env.local", "utf8");
} catch {
  console.error("Cannot read .env.local — run from apps/web (needs .env.local).");
  process.exit(2);
}
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const LIVE = process.argv.includes("--live");
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}
const LOCATION = argValue("--location") || "LAB52GY480CJF"; // FastTrax Fort Myers
// Clamped 2..25 — MAX also sizes the comp-minted funding GC ($MAX), so the
// clamp bounds the (comp, drained-at-exit) liability the probe ever holds.
const MAX = Math.max(2, Math.min(25, Number(argValue("--max") || 11) || 11));
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const AMOUNT = 100; // $1.00 per tender
const KEY = `probe-${randomUUID().slice(0, 8)}`;

console.log("\x1b[1m*** PRODUCTION SQUARE — live account. Comp funds only, but real objects. ***\x1b[0m");
console.log(`location=${LOCATION}  max=${MAX}  key=${KEY}`);

if (!LIVE) {
  console.log("\n=== DRY RUN (pass --live to execute) ===");
  console.log(`Would 1: comp-mint $${MAX} DIGITAL funding GC @ ${LOCATION}`);
  console.log(
    "         (mintDigitalGiftCard → POST /orders [$0 via catalog discount] + POST /orders/{id}/pay + POST /gift-cards + POST /gift-cards/activities ACTIVATE)",
  );
  console.log(`Would 2: POST /orders — one ad-hoc "Cap probe" line, $${MAX}.00`);
  console.log(
    `Would 3: POST /payments ×${MAX} — $1 each, source_id = funding GC, order_id set, autocomplete:false (keys ${KEY}-p1..p${MAX})`,
  );
  console.log(
    "Would 4: POST /orders/{id}/pay — payment_ids = every successful auth, NO order_version; on success GET /orders/{id} and verify state=COMPLETED + tender count",
  );
  console.log("Would 5: if a boundary < max is found: POST /payments/{id}/cancel for every auth, then");
  console.log(
    `         a) DISPROOF when the failing run was not already at cap+1: FRESH POST /orders sized (cap+1)×$1 + POST /payments ×(cap+1) (keys ${KEY}-d1..) + POST /orders/{id}/pay — must FAIL count-related`,
  );
  console.log(
    `         b) PROOF: FRESH POST /orders sized cap×$1 + POST /payments ×cap (keys ${KEY}-q1..) + POST /orders/{id}/pay + verify GET (capture proof at N=cap)`,
  );
  console.log("Would 6: cleanup (fault-isolated; also runs on SIGINT/SIGTERM/crash) — POST /payments/{id}/cancel (un-captured auths),");
  console.log("         POST /refunds (captured, full), PUT /orders/{id} state=CANCELED (unpaid orders — voided tenders don't block),");
  console.log("         GC balance re-poll, ADJUST_DECREMENT drain + DEACTIVATE + post-deactivate balance re-check");
  process.exit(0);
}

if (!TOKEN) {
  console.error("SQUARE_ACCESS_TOKEN is not set — add it to apps/web/.env.local and retry.");
  process.exit(2);
}

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
    // No Square call may ever throw — a network failure is just a failed call.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Verbatim-but-truncated Square error body — the whole point is diagnosis. */
const errText = (json: any) => JSON.stringify(json?.errors ?? json).slice(0, 600);

// ── Tracking: every created object is recorded BEFORE the next Square call ──
interface TrackedPayment {
  id: string;
  canceled: boolean;
  captured: boolean;
  refunded: boolean;
}
interface TrackedOrder {
  id: string;
  label: string;
  settled: boolean; // true once a GET-VERIFIED PayOrder captured it — never cancel, refund instead
}
const payments: TrackedPayment[] = [];
const orders: TrackedOrder[] = [];
const mintedCards: Array<{ id: string; label: string }> = [];

async function createProbeOrder(label: string, totalCents: number, keySuffix: string): Promise<TrackedOrder> {
  const r = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-${keySuffix}`,
    order: {
      location_id: LOCATION,
      line_items: [
        { name: label, quantity: "1", base_price_money: { amount: totalCents, currency: "USD" } },
      ],
    },
  });
  if (!r.ok) throw new Error(`order create (${label}) failed: ${errText(r.json)}`);
  const tracked: TrackedOrder = { id: r.json.order.id as string, label, settled: false };
  orders.push(tracked);
  return tracked;
}

/** $1 delayed-capture auth against an order. Returns the tracked payment or the raw error. */
async function authorize(
  orderId: string,
  sourceId: string,
  keySuffix: string,
): Promise<{ ok: true; payment: TrackedPayment } | { ok: false; json: any }> {
  const r = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-${keySuffix}`,
    source_id: sourceId,
    amount_money: { amount: AMOUNT, currency: "USD" },
    order_id: orderId,
    location_id: LOCATION,
    autocomplete: false,
  });
  if (!r.ok || !r.json?.payment?.id) return { ok: false, json: r.json };
  const payment: TrackedPayment = { id: r.json.payment.id, canceled: false, captured: false, refunded: false };
  payments.push(payment);
  return { ok: true, payment };
}

/** THE PROBED CALL — PayOrder with payment_ids only, deliberately NO order_version. */
async function payOrderVersionless(orderId: string, ids: string[], keySuffix: string) {
  return sq("POST", `/orders/${orderId}/pay`, {
    idempotency_key: `${KEY}-${keySuffix}`,
    payment_ids: ids,
  });
}

async function cancelAuth(p: TrackedPayment): Promise<void> {
  if (p.canceled || p.captured) return;
  const r = await sq("POST", `/payments/${p.id}/cancel`, {
    idempotency_key: `${KEY}-cancel-${p.id.slice(-8)}`,
  });
  if (r.ok) p.canceled = true;
  else
    console.log(
      `  MANUAL ACTION: payment ${p.id} — cancel FAILED (${errText(r.json)}); Square auto-voids unsettled auths in ~6 days, verify in the dashboard`,
    );
}

/** Poll the GC until its balance recovers to targetCents (cancel/refund settlement lag). */
async function waitForGcBalance(giftCardId: string, targetCents: number, label: string): Promise<number> {
  const deadline = Date.now() + 30_000;
  let bal = -1;
  for (;;) {
    bal = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.balance_money?.amount ?? 0;
    if (bal >= targetCents) return bal;
    if (Date.now() > deadline) break;
    await sleep(2000);
  }
  console.log(`  ${label}: balance ${bal}¢ after 30s (wanted ≥${targetCents}¢) — proceeding anyway`);
  return bal;
}

async function drainAndDeactivate(giftCardId: string, label: string): Promise<void> {
  const gc = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
  if (!gc) {
    console.log(
      `  MANUAL ACTION: gift card ${giftCardId} (${label}) — fetch failed; drain + deactivate it manually in the Square dashboard`,
    );
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
    if (r.ok) console.log(`  cleanup ${label}: drained ${bal}¢ → ok`);
    else
      console.log(
        `  MANUAL ACTION: gift card ${giftCardId} (${label}) — drain of ${bal}¢ FAILED (${errText(r.json)}); ADJUST_DECREMENT it manually`,
      );
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
    if (r.ok) console.log(`  cleanup ${label}: deactivate → ok`);
    else
      console.log(
        `  MANUAL ACTION: gift card ${giftCardId} (${label}) — deactivate FAILED (${errText(r.json)}); deactivate it manually`,
      );
  }
  // Post-deactivate re-check: a non-zero balance on a card we just tried to
  // drain+deactivate is stranded money — shout, don't whisper.
  const after = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
  const afterBal = after?.balance_money?.amount ?? 0;
  if (afterBal > 0) {
    console.log(
      `\x1b[1m  *** MANUAL ACTION: gift card ${giftCardId} (${label}) — state=${after?.state ?? "?"} with NON-ZERO balance ${afterBal}¢ after cleanup; recover it via the Square dashboard ***\x1b[0m`,
    );
  }
}

/** Is this Square error specifically a per-ORDER payment/tender COUNT limit?
 *  NOT an amount mismatch, NOT insufficient funds, NOT a per-gift-card
 *  limit/state error — those are never a cap signal. */
function isCountError(errors: any[] | undefined): boolean {
  return (errors ?? []).some((e) => {
    const t = `${e?.code ?? ""} ${e?.field ?? ""} ${e?.detail ?? ""}`.toLowerCase();
    if (/does not match|order total/.test(t)) return false; // amount mismatch, not a cap signal
    if (/insufficient/.test(t)) return false; // funds, not count
    if (/gift.?card/.test(t)) return false; // per-GC limit/state, not the per-order cap
    return (
      /payment_ids|payments|tender/.test(t) &&
      /max|limit|exceed|too many|too_high|no more than|at most/.test(t)
    );
  });
}

/** Pull the cap number out of the error detail — the LARGEST integer in
 *  [2, upper), preferring integers adjacent to a most/max/limit-style token
 *  (so "…at most 10 payments… order v3…" reads 10, not a stray digit). */
function extractCap(errors: any[] | undefined, upper: number): number | null {
  let best: number | null = null;
  let bestNearToken: number | null = null;
  const nearToken =
    /(?:most|max\w*|limit\w*|more than|up to|exceed\w*)\D{0,16}?(\d+)|(\d+)\D{0,16}?(?:max\w*|limit\w*|allowed|exceed\w*)/gi;
  for (const e of errors ?? []) {
    const detail = String(e?.detail ?? "");
    for (const m of detail.matchAll(nearToken)) {
      const n = Number(m[1] ?? m[2]);
      if (n >= 2 && n < upper && (bestNearToken === null || n > bestNearToken)) bestNearToken = n;
    }
    for (const s of detail.match(/\d+/g) ?? []) {
      const n = Number(s);
      if (n >= 2 && n < upper && (best === null || n > best)) best = n;
    }
  }
  return bestNearToken ?? best;
}

/** A successful PayOrder is only trusted after a GET confirms the order is
 *  COMPLETED with exactly the expected tender count — a 200 with anything
 *  else must never become a PROVEN claim. */
async function verifyCaptured(orderId: string, expectedTenders: number, label: string): Promise<boolean> {
  const r = await sq("GET", `/orders/${orderId}`);
  const o = r.json?.order;
  const tenders = o?.tenders?.length ?? 0;
  if (o?.state === "COMPLETED" && tenders === expectedTenders) {
    console.log(`   ✓ ${label} verified — order state=COMPLETED tenders=${tenders}`);
    return true;
  }
  console.log(
    `   ✗ ${label} verification MISMATCH — order state=${o?.state ?? "?"} tenders=${tenders} (expected COMPLETED with ${expectedTenders}) — NOT counting this as proven`,
  );
  console.log(`   raw order JSON: ${JSON.stringify(r.json)}`);
  return false;
}

// ── Findings ─────────────────────────────────────────────────────────────────
let observedAuthLimit: number | null = null; // boundary hit at CreatePayment time (null = none up to MAX)
let authFailureAmbiguous = false; // auth loop stopped on a NON-count error (per-GC limit / funds / state — not a cap signal)
let payOrderCap: number | null = null; // boundary reported by a PayOrder count error
let capAssumed = false; // cap number fell back to Square's documented 10 (error carried no number)
let disprovenAtNPlus1 = false; // a count-FAILURE was OBSERVED live at cap+1 (never inferred from error text)
let captureProvenAt: number | null = null; // N proven by a successful + GET-verified version-less PayOrder
let fundingCardId: string | null = null;

// ── Cleanup — single authority, ran-once, structurally throw-proof ───────────
// Runs from the main finally AND from the signal/crash handlers below. Every
// per-object step is fault-isolated: a failure prints "MANUAL ACTION: …" and
// moves on, so the VERDICT print + process.exit can never be skipped.
let cleanupPromise: Promise<void> | null = null;
function cleanup(): Promise<void> {
  if (!cleanupPromise) cleanupPromise = runCleanup();
  return cleanupPromise;
}
async function runCleanup(): Promise<void> {
  try {
    console.log("6. cleanup (guaranteed):");
    let refundsIssued = 0;
    let cancelsIssued = 0;

    // a. void every un-captured auth — each cancel isolated
    for (const p of payments) {
      try {
        const wasCanceled = p.canceled;
        await cancelAuth(p);
        if (!wasCanceled && p.canceled) cancelsIssued++;
      } catch (err) {
        console.log(
          `  MANUAL ACTION: payment ${p.id} — cancel threw (${String(err)}); check it in the Square dashboard (unsettled auths auto-void in ~6 days)`,
        );
      }
    }
    const voided = payments.filter((p) => p.canceled).length;
    if (voided) console.log(`  voided ${voided} un-captured auth(s)`);

    // b. FULL-refund every captured $1 payment (GC-funded full refunds are
    //    allowed → money flows back onto the funding GC). Shape mirrors
    //    refundSquarePayment in lib/square-gift-card.ts. Each refund isolated.
    for (const p of payments) {
      if (!p.captured || p.refunded) continue;
      try {
        const r = await sq("POST", "/refunds", {
          idempotency_key: `${KEY}-refund-${p.id.slice(-8)}`,
          payment_id: p.id,
          amount_money: { amount: AMOUNT, currency: "USD" },
          reason: "PayOrder cap probe cleanup",
        });
        if (r.ok) {
          p.refunded = true;
          refundsIssued++;
        } else {
          console.log(
            `  MANUAL ACTION: payment ${p.id} — refund FAILED (${errText(r.json)}); refund $1 manually in the Square dashboard`,
          );
        }
      } catch (err) {
        console.log(
          `  MANUAL ACTION: payment ${p.id} — refund threw (${String(err)}); refund $1 manually in the Square dashboard`,
        );
      }
    }
    if (refundsIssued) console.log(`  refunded ${refundsIssued}×$1 back to the funding GC`);

    // c. cancel unpaid orders (fresh version, same pattern as store-credit-probe).
    //    Voided/canceled tenders do NOT block a cancel attempt — only a tender
    //    whose payment actually COMPLETED does (tracked state first, GET to confirm).
    for (const o of orders) {
      try {
        if (o.settled) continue; // captured — money already reversed via refunds above
        const cur = (await sq("GET", `/orders/${o.id}`)).json?.order;
        if (!cur) {
          console.log(`  MANUAL ACTION: order ${o.id} (${o.label}) — fetch failed; verify its state in the Square dashboard`);
          continue;
        }
        if (cur.state !== "OPEN") {
          console.log(`  order ${o.id} (${o.label}) state=${cur.state} — no cancel needed`);
          continue;
        }
        let completedTenderId: string | null = null;
        for (const t of cur.tenders ?? []) {
          const pid = t?.payment_id as string | undefined;
          if (!pid) continue;
          const tracked = payments.find((p) => p.id === pid);
          if (tracked?.canceled) continue; // voided — never blocks a cancel
          if (tracked?.captured) {
            completedTenderId = pid;
            break;
          }
          const st = (await sq("GET", `/payments/${pid}`)).json?.payment?.status;
          if (st === "COMPLETED") {
            completedTenderId = pid;
            break;
          }
        }
        if (completedTenderId) {
          console.log(
            `  MANUAL ACTION: order ${o.id} (${o.label}) — OPEN with CAPTURED tender ${completedTenderId}; manual review (refund state printed above)`,
          );
          continue;
        }
        const r = await sq("PUT", `/orders/${o.id}`, {
          order: { location_id: cur.location_id, version: cur.version, state: "CANCELED" },
        });
        if (r.ok) console.log(`  order ${o.id} (${o.label}) cancelled → ok`);
        else
          console.log(
            `  MANUAL ACTION: order ${o.id} (${o.label}) — cancel FAILED (${errText(r.json)}); an unpaid OPEN order carries no liability, but verify in the dashboard`,
          );
      } catch (err) {
        console.log(
          `  MANUAL ACTION: order ${o.id} (${o.label}) — cleanup threw (${String(err)}); verify state + tenders in the Square dashboard`,
        );
      }
    }

    // d. let cancels/refunds settle back onto the GC before draining. The
    //    target accounts for money still off-card: captured-but-unrefunded
    //    payments plus auths we could not void (they may still hold balance).
    try {
      if (fundingCardId && refundsIssued + cancelsIssued > 0) {
        const unreversed = payments.filter((p) => (p.captured && !p.refunded) || (!p.captured && !p.canceled)).length;
        const target = Math.max(0, (MAX - unreversed) * AMOUNT);
        console.log(
          `  waiting for ${cancelsIssued} cancel(s) + ${refundsIssued} refund(s) to post back to the funding GC (target ≥${target}¢)…`,
        );
        await waitForGcBalance(fundingCardId, target, "funding GC (post-cleanup)");
      }
    } catch (err) {
      console.log(
        `  MANUAL ACTION: gift card ${fundingCardId} — balance poll threw (${String(err)}); check its balance before trusting the drain below`,
      );
    }

    // e. drain + deactivate every card this probe minted — each card isolated
    for (const c of mintedCards) {
      try {
        await drainAndDeactivate(c.id, c.label);
      } catch (err) {
        console.log(
          `  MANUAL ACTION: gift card ${c.id} (${c.label}) — drain/deactivate threw (${String(err)}); drain + deactivate it manually`,
        );
      }
    }
  } catch (err) {
    // Structurally unreachable (every unit above is isolated) — but if it ever
    // fires, dump the full manual trail rather than dying before the VERDICT.
    console.log(`  MANUAL ACTION: cleanup aborted unexpectedly (${String(err)}) — review these objects manually:`);
    for (const p of payments) console.log(`    payment ${p.id} captured=${p.captured} canceled=${p.canceled} refunded=${p.refunded}`);
    for (const o of orders) console.log(`    order ${o.id} (${o.label}) settled=${o.settled}`);
    for (const c of mintedCards) console.log(`    gift card ${c.id} (${c.label})`);
  }
}

// ── Crash / interrupt safety: cleanup ALWAYS runs, then exit 2 ────────────────
// Exit 1 is therefore unreachable — exit codes are only ever a deliberate
// verdict (0) or the catch-all 2.
let fatalHandled = false;
async function onFatal(label: string, err?: unknown): Promise<void> {
  if (fatalHandled) return;
  fatalHandled = true;
  console.error(`\n${label}${err !== undefined ? ": " + (err instanceof Error ? (err.stack ?? err.message) : String(err)) : ""}`);
  await cleanup(); // ran-once + throw-proof
  process.exit(2);
}
process.on("uncaughtException", (err) => void onFatal("UNCAUGHT EXCEPTION", err));
process.on("unhandledRejection", (err) => void onFatal("UNHANDLED REJECTION", err));
process.on("SIGINT", () => void onFatal("SIGINT — interrupted; running cleanup, then exit 2"));
process.on("SIGTERM", () => void onFatal("SIGTERM — interrupted; running cleanup, then exit 2"));

try {
  // ── 1. Funding card (comp mint, prod-proven pattern) ──────────────────────
  const { mintDigitalGiftCard } = await import("@/lib/square-gift-card");
  const discountId =
    process.env.SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID ||
    process.env.SQUARE_SURVEY_DISCOUNT_CATALOG_ID ||
    "37C3SN4245TUCN3RF7XMNKPU";
  console.log(`\n1. comp-minting $${MAX} funding gift card (discount ${discountId})…`);
  let funding: Awaited<ReturnType<typeof mintDigitalGiftCard>>;
  try {
    funding = await mintDigitalGiftCard({
      locationId: LOCATION,
      amountCents: MAX * AMOUNT,
      baseKey: `${KEY}-fund`,
      discountCatalogObjectId: discountId,
    });
  } catch (err) {
    // The mint is 4 Square calls — a mid-flight throw can leave a real order
    // and/or a PENDING/ACTIVE card behind that we hold no ids for. Its calls
    // use deterministic idempotency keys, so print them as the manual trail.
    console.error(
      `   MANUAL ACTION: mint threw mid-flight — it may have left a $${MAX} eGiftCard order and/or a gift card behind.\n` +
        `   Its Square calls used deterministic idempotency keys gc-order-${KEY}-fund / gc-pay-${KEY}-fund / gc-mint-${KEY}-fund / gc-act-${KEY}-fund —\n` +
        `   search today's $${MAX} eGiftCard orders at ${LOCATION} in the dashboard and deactivate any card they activated.`,
    );
    throw err;
  }
  mintedCards.push({ id: funding.giftCardId, label: "funding card" });
  fundingCardId = funding.giftCardId;
  console.log(`   funding card ${funding.giftCardId} gan=····${funding.gan.slice(-4)} $${MAX} ACTIVE`);

  // ── 2. The $MAX probe order ────────────────────────────────────────────────
  console.log(`2. creating "Cap probe" order — one ad-hoc $${MAX}.00 line…`);
  const order1 = await createProbeOrder("Cap probe", MAX * AMOUNT, "order1");
  console.log(`   order ${order1.id}`);

  // ── 3. Auth loop: $1 delayed-capture payments #1..MAX ─────────────────────
  console.log(`3. authorizing $1 payments #1..${MAX} (autocomplete:false, source = funding GC)…`);
  const order1Payments: TrackedPayment[] = [];
  for (let i = 1; i <= MAX; i++) {
    const a = await authorize(order1.id, funding.giftCardId, `p${i}`);
    if (!a.ok) {
      console.log(`   ✗ payment #${i} REJECTED`);
      console.log(`   error (verbatim): ${errText(a.json)}`);
      if (isCountError(a.json?.errors)) {
        observedAuthLimit = i - 1;
        console.log(`   count-related → auth-time boundary at ${observedAuthLimit}`);
      } else {
        // INSUFFICIENT_FUNDS / per-gift-card limits / network / anything
        // ambiguous is NOT a per-order cap signal — never turn it into a
        // verdict number. The verdict prints re-run guidance.
        authFailureAmbiguous = true;
        console.log("   NOT a per-order payment-count error — not a cap signal (see the verdict for guidance)");
      }
      break;
    }
    order1Payments.push(a.payment);
    console.log(`   ✓ #${i} ${a.payment.id}`);
  }
  if (order1Payments.length === 0) {
    throw new Error("payment #1 failed — nothing to probe (see the verbatim error above)");
  }

  // ── 4. PayOrder with everything that authorized ───────────────────────────
  let capCandidate: number | null = null;
  if (observedAuthLimit === null && !authFailureAmbiguous) {
    console.log(`4. PayOrder(${MAX} payment_ids, NO order_version)…`);
    const pr = await payOrderVersionless(order1.id, order1Payments.map((p) => p.id), "payorder1");
    if (pr.ok) {
      for (const p of order1Payments) p.captured = true;
      if (await verifyCaptured(order1.id, MAX, `PayOrder(${MAX})`)) {
        order1.settled = true;
        captureProvenAt = MAX;
        console.log(`   ✓ captured all ${MAX} tenders in one version-less PayOrder — no boundary up to --max ${MAX}`);
      }
    } else {
      console.log(`   ✗ PayOrder(${MAX}) REJECTED`);
      console.log(`   error (verbatim): ${errText(pr.json)}`);
      if (isCountError(pr.json?.errors)) {
        payOrderCap = extractCap(pr.json?.errors, MAX);
        if (payOrderCap === null) {
          payOrderCap = Math.min(10, MAX - 1);
          capAssumed = true;
        }
        capCandidate = payOrderCap;
        // This failing run only doubles as the cap+1 disproof when it sat at
        // exactly cap+1 — a number in the error TEXT alone never pins the cap.
        if (MAX === payOrderCap + 1) disprovenAtNPlus1 = true;
        console.log(
          `   count-related → PayOrder cap candidate = ${payOrderCap}${capAssumed ? " (no number in the error — assumed Square's documented 10)" : ""}${disprovenAtNPlus1 ? "" : ` — needs a fresh disproof at ${payOrderCap + 1}`}`,
        );
      } else {
        console.log("   NOT count-related — inconclusive; diagnose from the verbatim error above");
      }
    }
  } else if (observedAuthLimit !== null) {
    // Only observedAuthLimit×$1 is authorized against a $MAX order — PayOrder
    // here can only fail with an amount mismatch, which teaches nothing about
    // the cap. The count-related rejection of payment #(limit+1) already IS a
    // live failure at cap+1; go prove capture at the boundary.
    console.log(
      `4. skipping PayOrder on the $${MAX} order — only ${observedAuthLimit}×$1 authorized (would be an amount mismatch, not a cap signal)`,
    );
    capCandidate = observedAuthLimit;
    disprovenAtNPlus1 = true; // payment #(limit+1) was rejected live with a count error
  } else {
    console.log("4. skipping PayOrder — the auth loop stopped on a NON-count error; there is no cap signal to probe");
  }

  // ── 5. Pin the cap: SUCCESS at N=cap AND count-FAILURE at N=cap+1 ─────────
  if (capCandidate !== null && capCandidate >= 1) {
    console.log(
      `5. pinning cap=${capCandidate}: needs PayOrder success at ${capCandidate}${disprovenAtNPlus1 ? "" : ` AND a count-failure at ${capCandidate + 1}`}…`,
    );
    console.log(`   cancelling the ${order1Payments.length} probe auths to free the funding GC…`);
    for (const p of order1Payments) await cancelAuth(p);
    const needed = (disprovenAtNPlus1 ? capCandidate : capCandidate + 1) * AMOUNT;
    await waitForGcBalance(funding.giftCardId, needed, "funding GC (post-cancel)");

    // 5a. disproof at cap+1 — only when the failing run was not already there.
    let proofFundsAvailable = true;
    if (!disprovenAtNPlus1) {
      const m = capCandidate + 1;
      console.log(`   5a. disproof — fresh order sized ${m}×$1; PayOrder(${m}) must FAIL count-related…`);
      const orderD = await createProbeOrder("Cap probe (disproof)", m * AMOUNT, "orderD");
      console.log(`   disproof order ${orderD.id} ($${m}.00)`);
      const disproofPayments: TrackedPayment[] = [];
      let disproofAuthFailed = false;
      for (let i = 1; i <= m; i++) {
        const a = await authorize(orderD.id, funding.giftCardId, `d${i}`);
        if (!a.ok) {
          console.log(`   ✗ disproof auth #${i} REJECTED — error (verbatim): ${errText(a.json)}`);
          if (i === m && isCountError(a.json?.errors)) {
            disprovenAtNPlus1 = true;
            console.log(`   count-related rejection of payment #${m} — auth-time failure at ${m} counts as the disproof`);
          } else {
            console.log(`   cannot establish the ${m} disproof from this error`);
          }
          disproofAuthFailed = true;
          break;
        }
        disproofPayments.push(a.payment);
        console.log(`   ✓ d#${i} ${a.payment.id}`);
      }
      if (!disproofAuthFailed) {
        const prD = await payOrderVersionless(orderD.id, disproofPayments.map((p) => p.id), "payorderD");
        if (prD.ok) {
          for (const p of disproofPayments) p.captured = true;
          proofFundsAvailable = false; // the cap+1 auths just got captured — the GC can no longer fund the proof
          if (await verifyCaptured(orderD.id, m, `disproof PayOrder(${m})`)) {
            orderD.settled = true;
            captureProvenAt = m;
          }
          console.log(
            `   ✗ PayOrder(${m}) SUCCEEDED — the reported cap ${capCandidate} is DISPROVEN (real cap ≥ ${m}); re-run with a higher --max`,
          );
        } else {
          console.log(`   PayOrder(${m}) rejected — error (verbatim): ${errText(prD.json)}`);
          if (isCountError(prD.json?.errors)) {
            disprovenAtNPlus1 = true;
            console.log(`   ✓ count-related — failure at ${m} established`);
          } else {
            console.log(`   NOT count-related — the ${m} disproof is NOT established`);
          }
        }
      }
      for (const p of disproofPayments) await cancelAuth(p); // void whatever wasn't captured
      if (proofFundsAvailable) {
        await waitForGcBalance(funding.giftCardId, capCandidate * AMOUNT, "funding GC (post-disproof)");
      }
    }

    // 5b. capture proof at exactly N=cap on a FRESH, correctly-sized order.
    if (proofFundsAvailable) {
      console.log(`   5b. proof — fresh order sized ${capCandidate}×$1; version-less PayOrder(${capCandidate})…`);
      const order2 = await createProbeOrder("Cap probe (proof)", capCandidate * AMOUNT, "order2");
      console.log(`   proof order ${order2.id} ($${capCandidate}.00)`);
      const proofPayments: TrackedPayment[] = [];
      let proofAuthFailed = false;
      for (let i = 1; i <= capCandidate; i++) {
        const a = await authorize(order2.id, funding.giftCardId, `q${i}`);
        if (!a.ok) {
          console.log(`   ✗ proof auth #${i} REJECTED — cannot prove capture at ${capCandidate}`);
          console.log(`   error (verbatim): ${errText(a.json)}`);
          proofAuthFailed = true;
          break;
        }
        proofPayments.push(a.payment);
        console.log(`   ✓ q#${i} ${a.payment.id}`);
      }
      if (!proofAuthFailed) {
        console.log(`   ✓ ${capCandidate} auths — PayOrder(${capCandidate} payment_ids, NO order_version)…`);
        const pr2 = await payOrderVersionless(order2.id, proofPayments.map((p) => p.id), "payorder2");
        if (pr2.ok) {
          for (const p of proofPayments) p.captured = true;
          if (await verifyCaptured(order2.id, capCandidate, `proof PayOrder(${capCandidate})`)) {
            order2.settled = true;
            captureProvenAt = capCandidate;
            console.log(`   ✓ version-less capture PROVEN at N=${capCandidate}`);
          }
        } else {
          console.log(`   ✗ proof PayOrder(${capCandidate}) REJECTED — boundary known but capture at cap NOT proven`);
          console.log(`   error (verbatim): ${errText(pr2.json)}`);
        }
      }
    }
  }
} catch (err) {
  console.error("PROBE ERROR:", err instanceof Error ? err.message : err);
} finally {
  // ── 6. Cleanup — runs on EVERY path (fault-isolated + throw-proof inside
  // cleanup(), so the VERDICT below always prints). Zero liabilities left. ───
  await cleanup();
}

// ── VERDICT ───────────────────────────────────────────────────────────────────
const capNumber = payOrderCap ?? (observedAuthLimit && observedAuthLimit > 0 ? observedAuthLimit : null);
const authStr = observedAuthLimit === null ? `none up to ${MAX}` : String(observedAuthLimit);
const proven = capNumber !== null && captureProvenAt === capNumber;
// Pinned = PayOrder SUCCESS observed at cap AND a count-FAILURE observed at
// cap+1 — both live signals; a number in the error text alone never pins.
const pinned = proven && disprovenAtNPlus1;

if (pinned) {
  console.log(
    `\nVERDICT: cap=${capNumber} (auth-limit=${authStr}, payorder-cap=${payOrderCap ?? "not hit"}, capture-proven-at=${captureProvenAt}, failure-observed-at=${(capNumber as number) + 1})`,
  );
  console.log(`→ set SQUARE_MAX_TENDERS_PER_ORDER=${capNumber}`);
  process.exit(0);
} else if (capNumber === null && captureProvenAt === MAX) {
  console.log(
    `\nVERDICT: cap>=${MAX} — no boundary found; version-less capture works at ${MAX}. Re-run with a higher --max to find the ceiling.`,
  );
  process.exit(2);
} else if (authFailureAmbiguous) {
  console.log(
    `\nVERDICT: INCONCLUSIVE — the auth loop failed with a NON-count error (verbatim above); it may be a per-gift-card limit or a funds/state problem, not the order cap. Diversify funding across 2 gift cards to separate per-GC limits from the order cap, then re-run.`,
  );
  process.exit(2);
} else if (capNumber !== null && captureProvenAt !== null && captureProvenAt > capNumber) {
  console.log(
    `\nVERDICT: the reported cap ${capNumber} is DISPROVEN — version-less capture succeeded at ${captureProvenAt}. Re-run with --max above ${captureProvenAt} to find the real ceiling.`,
  );
  process.exit(2);
} else if (proven && !disprovenAtNPlus1) {
  console.log(
    `\nVERDICT: capture proven at ${captureProvenAt}, but a count-failure at ${(capNumber as number) + 1} was NOT observed${capAssumed ? " (the cap number was assumed — the error carried no number)" : ""} — the true cap may sit in [${capNumber}, ${MAX - 1}]. See the disproof errors above and re-run.`,
  );
  process.exit(2);
} else if (capNumber !== null) {
  console.log(
    `\nVERDICT: boundary observed at ${capNumber} (auth-limit=${authStr}, payorder-cap=${payOrderCap ?? "not hit"}) but capture at N=cap was NOT proven — see the verbatim errors above.`,
  );
  process.exit(2);
} else {
  console.log(`\nVERDICT: INCONCLUSIVE — no boundary learned (auth-limit=${authStr}). See the errors above.`);
  process.exit(2);
}
