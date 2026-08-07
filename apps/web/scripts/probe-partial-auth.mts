/**
 * ~$2 live probe — GO/NO-GO: does a Square Terminal checkout honor
 * accept_partial_authorization for a low-balance SQUARE GIFT CARD swiped at
 * the reader, against an order-linked auth-only checkout?
 *
 * The ambient gift-card kiosk design arms EVERY checkout with
 * payment_options { autocomplete:false, accept_partial_authorization:true } so
 * a guest can swipe a gift card that can't cover the total and the kiosk
 * collects the remainder on another tender (PayOrder captures the set
 * atomically). Square's docs and this repo's own research DISAGREE on how a
 * partial approval is reported (docs: amount_money is lowered; repo,
 * lib/square-gift-card.ts:118-123: amount_money stays at the REQUESTED amount
 * and approved_money carries the real figure). This probe settles it against
 * the live account, plus two follow-on questions the rail flip depends on.
 *
 * Sequence (numbered console steps match):
 *   1. Create a $2.00 order (one ad-hoc "Partial-auth probe" line).
 *   2. Terminal checkout A: the FULL $2.00 against the order,
 *      autocomplete:false + accept_partial_authorization:true
 *      ← PROBED CALL #1. A 400 naming accept_partial_authorization or
 *      autocomplete = Square rejects the combination on an order-linked
 *      Terminal checkout → NO-GO. Device/auth/429/5xx/network = INCONCLUSIVE.
 *      If accepted: human SWIPES the $1.00-balance GIFT CARD; poll. Assert:
 *        A1  checkout settles (record the status a short-approval ends in —
 *            expected COMPLETED with payment_ids; a decline instead of a
 *            partial approval = NO-GO with the payment's error codes)
 *        A2  the payment's amount_money vs approved_money — GO requires the
 *            APPROVED figure to be exactly 100¢; which field carries it is
 *            recorded verbatim (this settles the docs-vs-repo conflict)
 *        A3  payment status APPROVED (auto-captured = NO-GO), and its
 *            source_type / card_details.card.card_brand / last_4 recorded
 *            (drives gift-card display + the GC-cap counting rule)
 *   3. Terminal checkout B: the $1.00 remainder, same options; human taps a
 *      real CREDIT CARD; assert APPROVED for exactly 100¢.
 *   4. PayOrder with both payment_ids → order COMPLETED = GO.
 *   5. CANCELED-residue probe (separate $1.00 order): arm an auth-only
 *      checkout, do NOT tap, cancel it, re-read checkout + order — assert no
 *      payment exists. Informational (RESIDUE: CLEAN/DIRTY), not a verdict
 *      gate: it decides whether retiring the legacy CANCELED-replay chain
 *      ("a CANCELED checkout captured nothing") is safe.
 *   6. Cleanup (EVERY path — finally, SIGINT/SIGTERM, uncaught): harvest
 *      late-tap payment_ids from every checkout; cancel live checkouts; void
 *      APPROVED auths; refund captured payments in full (a gift-card refund
 *      restores the card's balance, so the probe card stays loaded at $1.00
 *      for re-runs); cancel un-captured orders. Fault-isolated units print
 *      "MANUAL ACTION: …" and move on. Worst case ~$2 captured and refunded.
 *
 * Exit-code contract:
 *   0 = GO           — partial-auth combo accepted; gift-card swipe partially
 *                      APPROVED at 100¢; remainder + PayOrder worked
 *   1 = NO-GO        — DELIBERATE verdict only: the payment_options combo
 *                      400-rejected; the short swipe DECLINED instead of
 *                      partially approving; the partial auto-captured; the
 *                      approved figure ≠ the gift card's balance; or PayOrder
 *                      400-refused the set
 *   2 = INCONCLUSIVE — swipe/tap timeout, device/auth/rate-limit/5xx/network,
 *                      missing .env.local, SIGINT/SIGTERM, unexpected crash
 *
 * Requires a human at the reader: ONE swipe of a real Square gift card loaded
 * to EXACTLY $1.00 (load it via Dashboard first), then ONE tap of a real
 * credit card ($1.00, refunded).
 * DRY RUN by default (prints the plan). Pass --live to execute.
 *
 * Run from apps/web:
 *   npx tsx scripts/probe-partial-auth.mts --device <deviceId> [--location <locId>] --live
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {
  console.error("Cannot read .env.local — run from apps/web (needs .env.local). Aborting.");
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
}

const LIVE = process.argv.includes("--live");
const DEVICE = argValue("--device");
const LOCATION = argValue("--location") || "LAB52GY480CJF"; // FastTrax Fort Myers (kiosk reader venue)
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const TOTAL = 200; // $2.00 order
const GC_BALANCE = 100; // the probe gift card is loaded to EXACTLY $1.00
const KEY = `pauth-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`location=${LOCATION} device=${DEVICE ?? "<--device required for --live>"}`);
  console.log("PREREQ: a real Square gift card loaded to EXACTLY $1.00, and a real credit card.");
  console.log('Would: 1. POST /orders — $2.00 ad-hoc "Partial-auth probe" line');
  console.log(
    "Would: 2. POST /terminals/checkouts — FULL $2.00, autocomplete:false + accept_partial_authorization:true ← PROBED CALL #1",
  );
  console.log("Would:    (400 naming accept_partial_authorization/autocomplete = NO-GO; device/auth/429/5xx = inconclusive)");
  console.log("Would:    HUMAN SWIPES THE $1.00 GIFT CARD; poll to a settled state (A1: record the status)");
  console.log("Would:    GET /payments/{A} — record amount_money vs approved_money (A2: approved figure must be 100¢),");
  console.log("Would:    status APPROVED not auto-captured, source_type + card_brand + last_4 (A3)");
  console.log("Would: 3. POST /terminals/checkouts — $1.00 remainder, same options; HUMAN TAPS CREDIT CARD; verify APPROVED 100¢");
  console.log("Would: 4. POST /orders/{id}/pay payment_ids:[A,B] — order COMPLETED = GO");
  console.log("Would: 5. residue probe: fresh $1.00 order, arm auth-only checkout, NO tap, cancel it, re-read — RESIDUE: CLEAN/DIRTY");
  console.log("Would: 6. cleanup (always): harvest late payments; cancel checkouts; void auths; refund captures (GC balance restored);");
  console.log("Would:    cancel un-captured orders. Exit: 0=GO 1=NO-GO (deliberate only) 2=inconclusive/interrupted.");
  process.exit(0);
}

if (!TOKEN) {
  console.error("SQUARE_ACCESS_TOKEN is not set (.env.local). Aborting.");
  process.exit(2);
}
if (!DEVICE) {
  console.error("--device <terminal deviceId> is required with --live. Aborting.");
  process.exit(2);
}

console.log(
  "\x1b[1m*** PRODUCTION SQUARE ACCOUNT — arms a real reader; drains a $1.00 gift card and charges a card $1.00 (all refunded) ***\x1b[0m",
);
console.log(`location=${LOCATION} device=${DEVICE} key=${KEY}\n`);

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
    // sq() must NEVER throw — a dropped connection becomes a normal failed
    // result so verdict classification and cleanup keep working.
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

const errStr = (json: any) => JSON.stringify(json?.errors ?? json).slice(0, 400);

/**
 * PROBED CALL #1's NO-GO gate: a DELIBERATE rejection of the payment_options
 * combination — HTTP 400 whose field/detail names accept_partial_authorization
 * (or its interaction with autocomplete). Device errors, 401/403, 429, 5xx and
 * network failures prove nothing.
 */
function isPartialAuthRejection(status: number, json: any): boolean {
  if (status !== 400) return false;
  const errs: any[] = Array.isArray(json?.errors) ? json.errors : [];
  return errs.some((e) => {
    const field = String(e?.field ?? "");
    const code = String(e?.code ?? "");
    const detail = String(e?.detail ?? "");
    if (field.includes("device_options") || code.startsWith("DEVICE_")) return false;
    return (
      field.includes("accept_partial_authorization") ||
      /accept_partial_authorization|partial.{0,20}authorization/i.test(detail) ||
      (field.includes("payment_options") && /autocomplete/i.test(detail))
    );
  });
}

/** The evidence record every payment GET feeds — printed verbatim for the PR. */
interface PaymentFacts {
  id: string;
  status: string;
  amountMoney: number | undefined;
  approvedMoney: number | undefined;
  totalMoney: number | undefined;
  sourceType: string | undefined;
  cardBrand: string | undefined;
  last4: string | undefined;
  delayAction: string | undefined;
  delayedUntil: string | undefined;
  errors: unknown;
}

async function paymentFacts(paymentId: string): Promise<PaymentFacts | null> {
  const got = await sq("GET", `/payments/${paymentId}`);
  const p = got.json?.payment;
  if (!p) return null;
  return {
    id: paymentId,
    status: p.status,
    amountMoney: p.amount_money?.amount,
    approvedMoney: p.approved_money?.amount,
    totalMoney: p.total_money?.amount,
    sourceType: p.source_type,
    cardBrand: p.card_details?.card?.card_brand,
    last4: p.card_details?.card?.last_4,
    delayAction: p.delay_action,
    delayedUntil: p.delayed_until,
    errors: p.card_details?.errors,
  };
}

function printFacts(label: string, f: PaymentFacts): void {
  console.log(
    `   ${label} ${f.id}\n` +
      `     status=${f.status} amount_money=${f.amountMoney}¢ approved_money=${f.approvedMoney ?? "(absent)"}¢ total_money=${f.totalMoney}¢\n` +
      `     source_type=${f.sourceType} card_brand=${f.cardBrand} last_4=${f.last4}\n` +
      `     delay_action=${f.delayAction} delayed_until=${f.delayedUntil}` +
      (f.errors ? `\n     card_details.errors=${JSON.stringify(f.errors).slice(0, 300)}` : ""),
  );
}

/** Poll a terminal checkout to a settled state. TIMEOUT = nobody swiped/tapped. */
async function pollCheckout(
  checkoutId: string,
  label: string,
): Promise<{ status: string; paymentIds: string[] }> {
  const deadline = Date.now() + 120_000;
  let last: { status: string; paymentIds: string[] } = { status: "UNKNOWN", paymentIds: [] };
  while (Date.now() < deadline) {
    const r = await sq("GET", `/terminals/checkouts/${checkoutId}`);
    const c = r.json?.checkout;
    last = { status: c?.status ?? "UNKNOWN", paymentIds: c?.payment_ids ?? [] };
    if (last.status === "COMPLETED" || last.status === "CANCELED") return last;
    await sleep(2000);
  }
  console.log(`   ${label}: poll TIMEOUT after 120s — last status=${last.status} payment_ids=${JSON.stringify(last.paymentIds)}`);
  return { status: `TIMEOUT(${last.status})`, paymentIds: last.paymentIds };
}

/** Marker for "verdict already decided — jump straight to cleanup". */
class Halt extends Error {}

// Every created Square object is tracked the moment it exists, so the finally
// block can unwind it no matter where the probe dies.
const checkouts: Array<{ id: string; label: string }> = [];
const payments: Array<{ id: string; label: string }> = [];
const orders: Array<{ id: string; label: string }> = [];
let verdict: "go" | "no-go" | "inconclusive" = "inconclusive";
let verdictNote = "";
let exitCode = 2;
// Set the moment PayOrder reports the main order COMPLETED. From then on its
// payments are captured — Square REFUSES /payments/{id}/cancel on them (live
// 2026-07-29) and their status can read APPROVED for a short lag window.
// Cleanup must poll-to-COMPLETED and REFUND, never void.
let orderCaptured = false;
let residueNote = "not probed";

const paymentStatus = new Map<string, string>();

/** Merge checkout-harvested payment_ids into the tracked list (dedup) — catches taps that land after a poll timeout. */
function harvestPaymentIds(ids: unknown, from: string): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id === "string" && id && !payments.some((p) => p.id === id)) {
      payments.push({ id, label: `payment (harvested from ${from})` });
      console.log(`  harvested late payment ${id} from ${from}`);
    }
  }
}

let cleanupPromise: Promise<void> | null = null;
/** Memoized cleanup entry point — every exit path awaits the SAME run. */
function cleanup(): Promise<void> {
  return (cleanupPromise ??= doCleanup());
}
/**
 * Unwind every tracked Square object. Fault-isolated per unit: a failure
 * prints "MANUAL ACTION" and moves on — this function can never throw, so the
 * VERDICT print always runs.
 */
async function doCleanup(): Promise<void> {
  console.log("cleanup:");
  try {
    // a) Free the reader FIRST and harvest payment_ids from every checkout.
    for (const ck of checkouts) {
      try {
        const got = await sq("GET", `/terminals/checkouts/${ck.id}`);
        const c = got.json?.checkout;
        harvestPaymentIds(c?.payment_ids, ck.label);
        const status: string | undefined = c?.status;
        if (status === "PENDING" || status === "IN_PROGRESS") {
          const r = await sq("POST", `/terminals/checkouts/${ck.id}/cancel`, {});
          console.log(`  ${ck.label} (${status}) cancel → ${r.ok ? "ok" : "FAILED " + errStr(r.json)}`);
          if (!r.ok) {
            const re = await sq("GET", `/terminals/checkouts/${ck.id}`);
            harvestPaymentIds(re.json?.checkout?.payment_ids, ck.label);
            console.log(`  MANUAL ACTION: terminal checkout ${ck.id} — cancel failed; confirm the reader is not still armed`);
          }
        } else if (!c) {
          console.log(`  MANUAL ACTION: terminal checkout ${ck.id} — could not fetch (${errStr(got.json)}); check it in the dashboard`);
        } else {
          console.log(`  ${ck.label} ${status} — no cancel needed`);
        }
      } catch (e) {
        console.log(`  MANUAL ACTION: terminal checkout ${ck.id} — cleanup threw (${String(e)}); check it in the dashboard`);
      }
    }
    // b) Payments: void un-captured auths, refund anything captured. A
    //    gift-card refund restores the card's balance (probe card stays $1.00).
    for (const p of payments) {
      try {
        const got = await sq("GET", `/payments/${p.id}`);
        const pay = got.json?.payment;
        if (!pay) {
          console.log(`  MANUAL ACTION: payment ${p.id} — status fetch failed (${errStr(got.json)}); void/refund it manually if needed`);
          continue;
        }
        paymentStatus.set(p.id, pay.status);
        const refundAmount = pay.approved_money?.amount ?? pay.amount_money?.amount ?? GC_BALANCE;
        if (pay.status === "APPROVED" && orderCaptured) {
          // Post-capture APPROVED lag — poll to COMPLETED, then refund.
          let status = pay.status;
          for (let i = 0; i < 5 && status !== "COMPLETED"; i++) {
            await sleep(1500);
            const re = await sq("GET", `/payments/${p.id}`);
            status = re.json?.payment?.status ?? status;
          }
          paymentStatus.set(p.id, status);
          const r = await sq("POST", "/refunds", {
            idempotency_key: `${KEY}-refund-${p.id.slice(-6)}`,
            payment_id: p.id,
            amount_money: { amount: refundAmount, currency: "USD" },
            reason: "Partial-auth probe cleanup",
          });
          console.log(
            `  ${p.label} captured (read ${status}) → refund ${refundAmount}¢ → ${
              r.ok ? `ok refund=${r.json.refund?.id} status=${r.json.refund?.status}` : "FAILED " + errStr(r.json)
            }`,
          );
          if (!r.ok)
            console.log(`  MANUAL ACTION: payment ${p.id} — captured ${refundAmount}¢ did not refund; REFUND it manually`);
        } else if (pay.status === "APPROVED") {
          const r = await sq("POST", `/payments/${p.id}/cancel`, {
            idempotency_key: `${KEY}-cancel-${p.id.slice(-6)}`,
          });
          if (r.ok) paymentStatus.set(p.id, "CANCELED");
          console.log(`  ${p.label} APPROVED → cancel → ${r.ok ? "ok (auth voided)" : "FAILED " + errStr(r.json)}`);
          if (!r.ok) console.log(`  MANUAL ACTION: payment ${p.id} — APPROVED auth did not void; cancel it manually`);
        } else if (pay.status === "COMPLETED") {
          const r = await sq("POST", "/refunds", {
            idempotency_key: `${KEY}-refund-${p.id.slice(-6)}`,
            payment_id: p.id,
            amount_money: { amount: refundAmount, currency: "USD" },
            reason: "Partial-auth probe cleanup",
          });
          console.log(
            `  ${p.label} COMPLETED → refund ${refundAmount}¢ → ${
              r.ok ? `ok refund=${r.json.refund?.id} status=${r.json.refund?.status}` : "FAILED " + errStr(r.json)
            }`,
          );
          if (!r.ok) console.log(`  MANUAL ACTION: payment ${p.id} — captured ${refundAmount}¢ did not refund; refund it manually`);
        } else {
          console.log(`  ${p.label} ${pay.status} — no action needed`);
        }
      } catch (e) {
        console.log(`  MANUAL ACTION: payment ${p.id} — cleanup threw (${String(e)}); void/refund it manually if needed`);
      }
    }
    // c) Orders: cancel each unless a tender's payment actually CAPTURED.
    for (const o of orders) {
      try {
        const got = await sq("GET", `/orders/${o.id}`);
        const ord = got.json?.order;
        if (!ord) {
          console.log(`  MANUAL ACTION: order ${o.id} — could not fetch (${errStr(got.json)}); check its state in the dashboard`);
        } else if (ord.state !== "OPEN") {
          console.log(`  ${o.label} state=${ord.state} — no cancel`);
        } else {
          let captured = false;
          for (const t of ord.tenders ?? []) {
            const pid: string | undefined = t?.payment_id;
            if (!pid) continue;
            let status = paymentStatus.get(pid);
            if (status === undefined) status = (await sq("GET", `/payments/${pid}`)).json?.payment?.status;
            if (status === "COMPLETED") captured = true;
            else if (status === undefined)
              console.log(`  MANUAL ACTION: payment ${pid} — tender status unfetchable; verify it before trusting the order state`);
          }
          if (captured) {
            console.log(`  MANUAL ACTION: order ${o.id} — order has CAPTURED tender — manual review (verify the refunds above landed)`);
          } else {
            const r = await sq("PUT", `/orders/${o.id}`, {
              order: { location_id: ord.location_id, version: ord.version, state: "CANCELED" },
            });
            console.log(`  ${o.label} cancelled → ${r.ok ? "ok" : "FAILED " + errStr(r.json)}`);
            if (!r.ok) console.log(`  MANUAL ACTION: order ${o.id} — cancel failed; cancel it manually`);
          }
        }
      } catch (e) {
        console.log(`  MANUAL ACTION: order ${o.id} — cleanup threw (${String(e)}); check/cancel it manually`);
      }
    }
  } catch (e) {
    // Unreachable by design — absolute backstop so cleanup can never throw.
    console.error("  cleanup aborted unexpectedly:", e);
    for (const ck of checkouts) console.log(`  MANUAL ACTION: terminal checkout ${ck.id} — review in dashboard`);
    for (const p of payments) console.log(`  MANUAL ACTION: payment ${p.id} — review in dashboard`);
    for (const o of orders) console.log(`  MANUAL ACTION: order ${o.id} — review in dashboard`);
  }
}

// Single exit gate: prints the verdict exactly once, then exits.
let finished = false;
function finish(code: number, verdictOutput: string): never {
  if (!finished) {
    finished = true;
    console.log(verdictOutput);
  }
  process.exit(code);
}

// Interrupts and uncaught errors: unwind, then exit 2 (INCONCLUSIVE).
async function bail(reason: string, err?: unknown): Promise<never> {
  if (err !== undefined) console.error(`\n${reason}:`, err);
  else console.error(`\n${reason} — running cleanup before exit…`);
  await cleanup();
  finish(2, `\nVERDICT: INCONCLUSIVE — ${reason} (nothing proven; cleanup attempted — see MANUAL ACTION lines above, if any)`);
}
process.on("SIGINT", () => void bail("SIGINT"));
process.on("SIGTERM", () => void bail("SIGTERM"));
process.on("uncaughtException", (err) => void bail("uncaughtException", err));
process.on("unhandledRejection", (err) => void bail("unhandledRejection", err));

try {
  // ── 1. $2.00 order with one ad-hoc line ───────────────────────────────────
  console.log('1. creating $2.00 "Partial-auth probe" order…');
  const orderRes = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-order`,
    order: {
      location_id: LOCATION,
      line_items: [
        { name: "Partial-auth probe", quantity: "1", base_price_money: { amount: TOTAL, currency: "USD" } },
      ],
    },
  });
  if (!orderRes.ok) throw new Error(`order create failed: ${errStr(orderRes.json)}`);
  const orderId = orderRes.json.order.id as string;
  orders.push({ id: orderId, label: "probe order" });
  console.log(`   order ${orderId} total=${orderRes.json.order.net_amount_due_money?.amount ?? TOTAL}¢`);

  // ── 2. PROBED CALL #1 — full-amount checkout with partial auth enabled ────
  console.log("2. terminal checkout A: FULL $2.00, autocomplete:false + accept_partial_authorization:true…");
  const ckA = await sq("POST", "/terminals/checkouts", {
    idempotency_key: `${KEY}-cka`,
    checkout: {
      amount_money: { amount: TOTAL, currency: "USD" },
      order_id: orderId,
      device_options: { device_id: DEVICE, skip_receipt_screen: true },
      payment_options: { autocomplete: false, accept_partial_authorization: true },
      reference_id: "probe-pauth-a",
      note: "Partial-auth probe — refunded immediately",
    },
  });
  if (!ckA.ok) {
    console.log(`   ✗ checkout A POST failed (HTTP ${ckA.status})`);
    console.log(`   error: ${errStr(ckA.json)}`);
    if (isPartialAuthRejection(ckA.status, ckA.json)) {
      verdict = "no-go";
      verdictNote =
        "Square 400-rejected accept_partial_authorization on an order-linked auth-only Terminal checkout — ambient physical-GC partials are off the table (eGift scans still split via the GAN rail)";
      exitCode = 1;
    } else {
      verdict = "inconclusive";
      verdictNote = "checkout A failed with a non-verdict error (device/auth/rate-limit/5xx/network) — nothing proven";
      exitCode = 2;
    }
    throw new Halt();
  }
  const checkoutAId = ckA.json.checkout.id as string;
  checkouts.push({ id: checkoutAId, label: "checkout A" });
  console.log(`   ✓ combination ACCEPTED — checkout A ${checkoutAId} status=${ckA.json.checkout.status}`);
  console.log(`   >>> SWIPE THE $1.00 GIFT CARD NOW (do NOT tap a bank card) <<<`);
  const polledA = await pollCheckout(checkoutAId, "checkout A");
  harvestPaymentIds(polledA.paymentIds, "checkout A");
  console.log(`   A1: checkout A settled status=${polledA.status} payment_ids=${JSON.stringify(polledA.paymentIds)}`);
  const paymentAId = polledA.paymentIds[0];
  if (!paymentAId) {
    verdict = "inconclusive";
    verdictNote = `checkout A ended ${polledA.status} with no payment — swipe never landed (timeout/cancel); nothing proven`;
    exitCode = 2;
    throw new Halt();
  }
  payments.push({ id: paymentAId, label: "payment A (gift card)" });
  const factsA = await paymentFacts(paymentAId);
  if (!factsA) {
    verdict = "inconclusive";
    verdictNote = `payment A ${paymentAId} unfetchable — nothing proven`;
    exitCode = 2;
    throw new Halt();
  }
  printFacts("A2/A3: payment A", factsA);
  if (factsA.status === "FAILED" || factsA.status === "CANCELED") {
    verdict = "no-go";
    verdictNote = `the short swipe DECLINED (payment ${factsA.status}, errors=${JSON.stringify(factsA.errors).slice(0, 200)}) instead of partially approving — Terminal does not honor accept_partial_authorization here`;
    exitCode = 1;
    throw new Halt();
  }
  if (factsA.status === "COMPLETED") {
    verdict = "no-go";
    verdictNote = "payment A auto-captured — Terminal ignored autocomplete:false; atomic PayOrder capture impossible";
    exitCode = 1;
    throw new Halt();
  }
  if (factsA.status !== "APPROVED") {
    verdict = "inconclusive";
    verdictNote = `payment A in unexpected status ${factsA.status} — nothing proven`;
    exitCode = 2;
    throw new Halt();
  }
  // A2 — the conflict-settler: the APPROVED figure must equal the card's balance.
  const effectiveA = factsA.approvedMoney ?? factsA.amountMoney;
  if (effectiveA !== GC_BALANCE) {
    if (factsA.amountMoney === TOTAL && factsA.approvedMoney === undefined) {
      verdict = "no-go";
      verdictNote = `payment A APPROVED at the FULL ${TOTAL}¢ with no approved_money — either the gift card held ≥ $2.00 (reload it to exactly $1.00 and re-run) or partial auth silently didn't partial`;
      exitCode = 1;
    } else {
      verdict = "no-go";
      verdictNote = `partial approval figure is ${effectiveA}¢ (amount_money=${factsA.amountMoney}, approved_money=${factsA.approvedMoney}) — expected exactly ${GC_BALANCE}¢; remainder math cannot trust either field`;
      exitCode = 1;
    }
    throw new Halt();
  }
  console.log(
    `   ✓ A2: partial APPROVED at ${GC_BALANCE}¢ — carried by ${
      factsA.approvedMoney === GC_BALANCE && factsA.amountMoney !== GC_BALANCE
        ? "approved_money (amount_money stays at requested — REPO claim confirmed)"
        : factsA.amountMoney === GC_BALANCE
          ? "amount_money (lowered to approved — DOCS claim confirmed)"
          : "both fields"
    }`,
  );
  console.log(`   ✓ A3: source_type=${factsA.sourceType} card_brand=${factsA.cardBrand} last_4=${factsA.last4}`);

  // ── 3. Remainder checkout — credit card tap ────────────────────────────────
  const remainder = TOTAL - GC_BALANCE;
  console.log(`3. terminal checkout B: ${remainder}¢ remainder, same payment_options…`);
  const ckB = await sq("POST", "/terminals/checkouts", {
    idempotency_key: `${KEY}-ckb`,
    checkout: {
      amount_money: { amount: remainder, currency: "USD" },
      order_id: orderId,
      device_options: { device_id: DEVICE, skip_receipt_screen: true },
      payment_options: { autocomplete: false, accept_partial_authorization: true },
      reference_id: "probe-pauth-b",
      note: "Partial-auth probe — refunded immediately",
    },
  });
  if (!ckB.ok) {
    console.log(`   ✗ checkout B POST failed (HTTP ${ckB.status}): ${errStr(ckB.json)}`);
    verdict = ckB.status === 400 ? "no-go" : "inconclusive";
    verdictNote =
      ckB.status === 400
        ? "Square 400-refused the remainder checkout after a partial approval — the follow-up-checkout loop does not work order-linked"
        : "checkout B failed with a non-verdict error — nothing proven";
    exitCode = ckB.status === 400 ? 1 : 2;
    throw new Halt();
  }
  const checkoutBId = ckB.json.checkout.id as string;
  checkouts.push({ id: checkoutBId, label: "checkout B" });
  console.log(`   checkout B ${checkoutBId} status=${ckB.json.checkout.status}`);
  console.log(`   >>> TAP THE CREDIT CARD NOW ($${(remainder / 100).toFixed(2)}) <<<`);
  const polledB = await pollCheckout(checkoutBId, "checkout B");
  harvestPaymentIds(polledB.paymentIds, "checkout B");
  const paymentBId = polledB.paymentIds[0];
  if (polledB.status !== "COMPLETED" || !paymentBId) {
    verdict = "inconclusive";
    verdictNote = `checkout B ended ${polledB.status} — tap never landed; nothing proven`;
    exitCode = 2;
    throw new Halt();
  }
  payments.push({ id: paymentBId, label: "payment B (credit card)" });
  const factsB = await paymentFacts(paymentBId);
  if (!factsB) {
    verdict = "inconclusive";
    verdictNote = `payment B ${paymentBId} unfetchable — nothing proven`;
    exitCode = 2;
    throw new Halt();
  }
  printFacts("payment B", factsB);
  if (factsB.status !== "APPROVED" || (factsB.approvedMoney ?? factsB.amountMoney) !== remainder) {
    verdict = "inconclusive";
    verdictNote = `payment B status=${factsB.status} effective=${factsB.approvedMoney ?? factsB.amountMoney}¢ (expected APPROVED ${remainder}¢) — nothing proven`;
    exitCode = 2;
    throw new Halt();
  }
  console.log(`   ✓ payment B APPROVED at ${remainder}¢`);

  // ── 4. PayOrder — capture both atomically ──────────────────────────────────
  console.log("4. PayOrder with both payment_ids…");
  const payOrderBody = { idempotency_key: `${KEY}-payorder`, payment_ids: [paymentAId, paymentBId] };
  let payOrderRes = await sq("POST", `/orders/${orderId}/pay`, payOrderBody);
  if (!payOrderRes.ok && (payOrderRes.status >= 500 || payOrderRes.status === 0)) {
    console.log(`   PayOrder transient failure (HTTP ${payOrderRes.status}) — retrying once…`);
    await sleep(2000);
    payOrderRes = await sq("POST", `/orders/${orderId}/pay`, payOrderBody);
  }
  if (!payOrderRes.ok) {
    console.log(`   ✗ PayOrder failed (HTTP ${payOrderRes.status}): ${errStr(payOrderRes.json)}`);
    verdict = payOrderRes.status === 400 ? "no-go" : "inconclusive";
    verdictNote =
      payOrderRes.status === 400
        ? "PayOrder refused the partial-auth + remainder payment set (400)"
        : `PayOrder failed with HTTP ${payOrderRes.status} — nothing proven`;
    exitCode = payOrderRes.status === 400 ? 1 : 2;
    throw new Halt();
  }
  const finalState = payOrderRes.json.order?.state;
  console.log(`   PayOrder ok — order state=${finalState}`);
  if (finalState !== "COMPLETED") {
    verdict = "inconclusive";
    verdictNote = `PayOrder returned 200 but order state=${finalState} (expected COMPLETED) — investigate before building on this`;
    exitCode = 2;
    throw new Halt();
  }
  orderCaptured = true; // cleanup must REFUND, never void, from here on
  verdict = "go";
  verdictNote =
    "order-linked partial auth works end-to-end: gift-card swipe partially APPROVED, remainder tapped, PayOrder captured both";
  exitCode = 0;

  // ── 5. CANCELED-residue probe (informational — never changes the verdict) ──
  console.log("5. residue probe: arm + cancel WITHOUT a swipe (fresh $1.00 order)…");
  try {
    const resOrder = await sq("POST", "/orders", {
      idempotency_key: `${KEY}-resorder`,
      order: {
        location_id: LOCATION,
        line_items: [{ name: "Residue probe", quantity: "1", base_price_money: { amount: 100, currency: "USD" } }],
      },
    });
    if (!resOrder.ok) throw new Error(`residue order create failed: ${errStr(resOrder.json)}`);
    const resOrderId = resOrder.json.order.id as string;
    orders.push({ id: resOrderId, label: "residue order" });
    const resCk = await sq("POST", "/terminals/checkouts", {
      idempotency_key: `${KEY}-resck`,
      checkout: {
        amount_money: { amount: 100, currency: "USD" },
        order_id: resOrderId,
        device_options: { device_id: DEVICE, skip_receipt_screen: true },
        payment_options: { autocomplete: false, accept_partial_authorization: true },
        reference_id: "probe-pauth-residue",
        note: "Partial-auth probe (residue) — cancelled immediately, do not swipe",
      },
    });
    if (!resCk.ok) throw new Error(`residue checkout create failed: ${errStr(resCk.json)}`);
    const resCkId = resCk.json.checkout.id as string;
    checkouts.push({ id: resCkId, label: "residue checkout" });
    console.log(`   residue checkout ${resCkId} armed — cancelling WITHOUT a swipe…`);
    await sleep(3000); // let the reader actually arm before the cancel
    const cancelRes = await sq("POST", `/terminals/checkouts/${resCkId}/cancel`, {});
    if (!cancelRes.ok) throw new Error(`residue cancel failed: ${errStr(cancelRes.json)}`);
    await sleep(2000);
    const reRead = await sq("GET", `/terminals/checkouts/${resCkId}`);
    const residualIds: string[] = reRead.json?.checkout?.payment_ids ?? [];
    harvestPaymentIds(residualIds, "residue checkout");
    const reOrder = await sq("GET", `/orders/${resOrderId}`);
    const residualTenders = (reOrder.json?.order?.tenders ?? []).length;
    residueNote =
      residualIds.length === 0 && residualTenders === 0
        ? "CLEAN — a CANCELED auth-only checkout left no payment and no tender (legacy CANCELED-replay-chain retirement is safe)"
        : `DIRTY — CANCELED checkout left payment_ids=${JSON.stringify(residualIds)} tenders=${residualTenders}; unwind MUST harvest-and-void dismissed checkouts`;
    console.log(`   RESIDUE: ${residueNote}`);
  } catch (e) {
    residueNote = `not settled (${String(e).slice(0, 200)}) — treat dismissed checkouts as potentially dirty until re-probed`;
    console.log(`   RESIDUE: ${residueNote}`);
  }
} catch (err) {
  if (!(err instanceof Halt)) {
    console.error("PROBE ERROR:", err instanceof Error ? err.message : err);
    if (!verdictNote) verdictNote = "unexpected error — see PROBE ERROR above";
  }
} finally {
  try {
    await cleanup();
  } catch (e) {
    console.error("cleanup failed unexpectedly:", e);
  }
}

const guidance =
  verdict === "go"
    ? "→ ambient gift cards can arm every kiosk checkout with accept_partial_authorization; wire effectiveCents = approved_money ?? amount_money per the A2 line above"
    : verdict === "no-go"
      ? "→ ship the rail WITHOUT accept_partial_authorization: eGift scans still split via the GAN rail; physical low-balance GC swipes keep declining at the reader"
      : "→ nothing proven — re-run with a human at the reader and a $1.00-balance gift card";
finish(exitCode, `\nVERDICT: ${verdict.toUpperCase()} — ${verdictNote}\nRESIDUE: ${residueNote}\n${guidance}`);
