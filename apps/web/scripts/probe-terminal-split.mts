/**
 * $2 live probe — GO/NO-GO: does Square Terminal accept a PARTIAL-amount
 * checkout against an order, TWICE, and then let PayOrder capture both?
 *
 * The split-tender kiosk design needs the reader to take two taps against ONE
 * order (each for part of the net due) with autocomplete:false, so both auths
 * can be captured atomically via PayOrder. Square's docs are ambiguous on
 * whether an order-linked Terminal checkout may carry amount_money < the
 * order's net due — this probe settles it against the live account.
 *
 * Sequence (numbered console steps match):
 *   1. Create a $2.00 order (one ad-hoc "Split probe" line) at the location.
 *   2. Terminal checkout A: $1.00 against the order, autocomplete:false
 *      ← THE PROBED CALL. A 400 referencing amount/order total = Square
 *      rejects partial amounts → NO-GO. Any other failure (device error,
 *      401/403, 429, 5xx, network) proves nothing → INCONCLUSIVE.
 *      If accepted: human taps a real card; poll to COMPLETED; verify the
 *      payment is APPROVED (if Square auto-COMPLETED it, Terminal ignores
 *      autocomplete:false → atomic capture impossible → NO-GO) and that the
 *      auth is for exactly $1.00 (coerced to the $2.00 net due → NO-GO).
 *   3. Terminal checkout B: the remaining $1.00, same shape, second tap.
 *   4. PayOrder with both payment_ids (no order_version) → order COMPLETED = GO.
 *   5. Cleanup (runs on EVERY path — finally, SIGINT/SIGTERM, uncaught error):
 *      GET each terminal checkout and harvest any late-tap payment_ids into
 *      the payment sweep; cancel PENDING/IN_PROGRESS checkouts; cancel
 *      APPROVED-not-captured payments; refund ANY captured payment in full;
 *      cancel the order unless a tender was actually CAPTURED (then: manual
 *      review). Every cleanup unit is fault-isolated — a failure prints a
 *      "MANUAL ACTION: …" line and moves on. No gift cards are minted by this
 *      probe. Worst case $2 is captured and immediately refunded to the card.
 *
 * Exit-code contract:
 *   0 = GO           — two partial checkouts + PayOrder all worked end-to-end
 *   1 = NO-GO        — a DELIBERATE verdict ONLY: partial checkout rejected
 *                      with a 400 referencing amount/order total, the partial
 *                      amount coerced to the order's net due,
 *                      autocomplete:false ignored, or PayOrder 400-refused
 *   2 = INCONCLUSIVE — tap timeout, device/auth/rate-limit/5xx/network error,
 *                      missing .env.local, SIGINT/SIGTERM, or unexpected crash
 *                      (nothing proven; cleanup still ran)
 *
 * Requires a human at the reader: TWO taps of a real card, $1.00 each.
 * DRY RUN by default (prints the plan). Pass --live to execute.
 *
 * Run from apps/web:
 *   npx tsx scripts/probe-terminal-split.mts --device <deviceId> [--location <locId>] --live
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
const HALF = 100; // $1.00 per tap
const KEY = `probe-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`location=${LOCATION} device=${DEVICE ?? "<--device required for --live>"}`);
  console.log(`Would: 1. POST /orders — $2.00 ad-hoc "Split probe" line @ ${LOCATION}`);
  console.log(
    'Would: 2. POST /terminals/checkouts — $1.00 against the order, autocomplete:false, ref "probe-split-a" ← THE PROBED CALL (amount/total 400 = NO-GO; device/auth/429/5xx = inconclusive)',
  );
  console.log("Would:    poll GET /terminals/checkouts/{id} every 2s (max 120s) to COMPLETED — HUMAN TAPS CARD ($1.00)");
  console.log("Would:    GET /payments/{A} — expect APPROVED (COMPLETED = autocomplete ignored = NO-GO)");
  console.log('Would: 3. POST /terminals/checkouts — remaining $1.00, ref "probe-split-b"; poll; second tap; verify APPROVED');
  console.log("Would: 4. POST /orders/{id}/pay payment_ids:[A,B] (no order_version) — order COMPLETED = GO");
  console.log("Would: 5. cleanup (always; also on SIGINT/SIGTERM/crash): harvest late-tap payment_ids from checkouts;");
  console.log("Would:    cancel live checkouts; cancel APPROVED payments; refund captured payments in full (POST /refunds);");
  console.log("Would:    cancel the order unless a tender was actually CAPTURED (then: MANUAL ACTION — manual review)");
  console.log("Exit: 0=GO 1=NO-GO (deliberate verdict only) 2=inconclusive/interrupted. Zero liabilities left either way.");
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

console.log("\x1b[1m*** PRODUCTION SQUARE ACCOUNT — this arms a real reader and charges a real card $2 (refunded at the end) ***\x1b[0m");
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
 * A NO-GO on the probed call requires a DELIBERATE rejection: HTTP 400 whose
 * error field/detail references amount_money or an order-total mismatch.
 * Device errors (device_options.device_id field, DEVICE_* codes), 401/403,
 * 429, 5xx, and network failures prove nothing about partial amounts.
 */
function isPartialAmountRejection(status: number, json: any): boolean {
  if (status !== 400) return false;
  const errs: any[] = Array.isArray(json?.errors) ? json.errors : [];
  return errs.some((e) => {
    const field = String(e?.field ?? "");
    const code = String(e?.code ?? "");
    const detail = String(e?.detail ?? "");
    if (field.includes("device_options") || code.startsWith("DEVICE_")) return false;
    return (
      field.includes("amount_money") ||
      /amount_money|order.{0,20}total|total.{0,20}order|net.{0,10}(amount|due)|partial/i.test(detail)
    );
  });
}

/** Poll a terminal checkout to a settled state. TIMEOUT = guest never tapped. */
async function pollCheckout(
  checkoutId: string,
  label: string,
): Promise<{ status: string; paymentIds: string[] }> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const r = await sq("GET", `/terminals/checkouts/${checkoutId}`);
    const c = r.json?.checkout;
    const status: string = c?.status ?? "UNKNOWN";
    if (status === "COMPLETED" || status === "CANCELED") {
      return { status, paymentIds: c?.payment_ids ?? [] };
    }
    await sleep(2000);
  }
  console.log(`   ${label}: poll TIMEOUT after 120s (no tap)`);
  return { status: "TIMEOUT", paymentIds: [] };
}

/**
 * Run a checkout leg: arm reader for `amount`, wait for the tap, verify the
 * auth is APPROVED and for exactly `amount` (not coerced to `netDue`).
 * failed: "rejected"/"autocompleted"/"coerced" are NO-GO evidence;
 *         "error" (device/auth/rate-limit/5xx/network) and "not-completed"
 *         (timeout/cancel/odd state) are inconclusive.
 */
async function checkoutLeg(
  label: "a" | "b",
  orderId: string,
  amount: number,
  netDue: number,
): Promise<{ paymentId: string } | { failed: "rejected" | "error" | "autocompleted" | "coerced" | "not-completed" }> {
  const res = await sq("POST", "/terminals/checkouts", {
    idempotency_key: `${KEY}-ck${label}`,
    checkout: {
      amount_money: { amount, currency: "USD" },
      order_id: orderId,
      device_options: { device_id: DEVICE, skip_receipt_screen: true },
      payment_options: { autocomplete: false },
      reference_id: `probe-split-${label}`,
      note: "Terminal split probe — refunded immediately",
    },
  });
  if (!res.ok) {
    console.log(`   ✗ checkout ${label.toUpperCase()} POST failed (HTTP ${res.status})`);
    console.log(`   error: ${errStr(res.json)}`);
    if (isPartialAmountRejection(res.status, res.json)) {
      console.log("   → 400 referencing amount/order total — Square deliberately rejects the partial amount");
      return { failed: "rejected" };
    }
    console.log("   → NOT an amount rejection (device/auth/rate-limit/5xx/network) — inconclusive, not a verdict");
    return { failed: "error" };
  }
  const checkoutId = res.json.checkout.id as string;
  checkouts.push({ id: checkoutId, label: `checkout ${label.toUpperCase()}` }); // tracked BEFORE any further call
  console.log(`   checkout ${label.toUpperCase()} ${checkoutId} status=${res.json.checkout.status}`);
  console.log(`   >>> TAP CARD NOW ($${(amount / 100).toFixed(2)}) <<<`);
  const polled = await pollCheckout(checkoutId, `checkout ${label.toUpperCase()}`);
  if (polled.status !== "COMPLETED") {
    console.log(`   checkout ${label.toUpperCase()} ended ${polled.status} — cannot continue`);
    return { failed: "not-completed" };
  }
  const paymentId = polled.paymentIds[0];
  if (!paymentId) {
    console.log(`   checkout ${label.toUpperCase()} COMPLETED but returned no payment_ids — cannot continue`);
    return { failed: "not-completed" };
  }
  payments.push({ id: paymentId, label: `payment ${label.toUpperCase()}` }); // tracked BEFORE the status GET
  console.log(`   payment ${label.toUpperCase()} ${paymentId} (tracked)`); // id in the log even if we die mid-GET
  const pay = (await sq("GET", `/payments/${paymentId}`)).json?.payment;
  console.log(`   payment ${label.toUpperCase()} ${paymentId} status=${pay?.status} amount=${pay?.amount_money?.amount}¢`);
  if (pay?.status === "COMPLETED") {
    console.log("   ✗ payment auto-COMPLETED — Terminal ignored autocomplete:false; atomic PayOrder capture is impossible");
    return { failed: "autocompleted" };
  }
  if (pay?.status !== "APPROVED") {
    console.log(`   ? unexpected payment status ${pay?.status} — treating as inconclusive`);
    return { failed: "not-completed" };
  }
  const authedAmount = pay?.amount_money?.amount;
  if (authedAmount !== amount) {
    if (authedAmount === netDue) {
      console.log(`   ✗ payment ${label.toUpperCase()} authorized ${authedAmount}¢ = the order's net due, not the requested ${amount}¢`);
      return { failed: "coerced" };
    }
    console.log(`   ? payment ${label.toUpperCase()} authorized ${authedAmount}¢ ≠ requested ${amount}¢ (nor net due ${netDue}¢) — inconclusive`);
    return { failed: "not-completed" };
  }
  return { paymentId };
}

/** Marker for "verdict already decided — jump straight to cleanup". */
class Halt extends Error {}

// Every created Square object is tracked here the moment it exists, so the
// finally block can unwind it no matter where the probe dies.
const checkouts: Array<{ id: string; label: string }> = [];
const payments: Array<{ id: string; label: string }> = [];
let orderId: string | null = null;
let verdict: "go" | "no-go" | "inconclusive" = "inconclusive";
let verdictNote = "";
let exitCode = 2;
// Set the moment PayOrder reports the order COMPLETED. From then on the
// payments are "attached to the order and guaranteed to complete" — Square
// REFUSES /payments/{id}/cancel on them (live 2026-07-29), and their status
// can read APPROVED for a short lag window after capture. Cleanup must
// poll-to-COMPLETED and REFUND, never void.
let orderCaptured = false;

// Last-known payment status by id (recorded during the payment sweep) so the
// order-cancel step can tell CAPTURED tenders from voided ones.
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
/**
 * Memoized cleanup entry point: EVERY caller (finally, SIGINT/SIGTERM,
 * uncaught handlers) awaits the SAME in-flight doCleanup() run, so no exit
 * path can fire mid-cleanup or skip it.
 */
function cleanup(): Promise<void> {
  return (cleanupPromise ??= doCleanup());
}
/**
 * Unwind every tracked Square object. Runs once, via cleanup()'s memoized
 * promise — from the finally block, a SIGINT/SIGTERM, or an uncaught error.
 * Every per-object unit is fault-isolated: a failure prints a "MANUAL ACTION"
 * line and moves on, so this function can never throw and the VERDICT print
 * always runs.
 */
async function doCleanup(): Promise<void> {
  console.log("cleanup:");
  try {
    // a) Free the reader FIRST so no new payment can arrive mid-cleanup, and
    //    harvest payment_ids from every checkout GET — a tap that landed after
    //    the poll timeout still enters the payment sweep below.
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
            // A tap may have landed between the GET and the cancel — re-GET and harvest.
            const re = await sq("GET", `/terminals/checkouts/${ck.id}`);
            harvestPaymentIds(re.json?.checkout?.payment_ids, ck.label);
            console.log(`  MANUAL ACTION: terminal checkout ${ck.id} — cancel failed; confirm the reader is not still armed`);
          }
        } else if (!c) {
          console.log(`  MANUAL ACTION: terminal checkout ${ck.id} — could not fetch (${errStr(got.json)}); check it and its payments in the dashboard`);
        } else {
          console.log(`  ${ck.label} ${status} — no cancel needed`);
        }
      } catch (e) {
        console.log(`  MANUAL ACTION: terminal checkout ${ck.id} — cleanup threw (${String(e)}); check it and its payments in the dashboard`);
      }
    }
    // b) Payments: void un-captured auths, refund anything captured (whether via
    //    PayOrder or an autocomplete:false-ignoring auto-capture).
    for (const p of payments) {
      try {
        const got = await sq("GET", `/payments/${p.id}`);
        const pay = got.json?.payment;
        if (!pay) {
          console.log(`  MANUAL ACTION: payment ${p.id} — status fetch failed (${errStr(got.json)}); void/refund it manually if needed`);
          continue;
        }
        paymentStatus.set(p.id, pay.status);
        // Post-capture, a payment can briefly still READ as APPROVED while the
        // order is already COMPLETED (live 2026-07-29: cancel then fails with
        // "attached to the order and guaranteed to complete"). Key the branch
        // off orderCaptured, not the read-back status: poll to COMPLETED, then
        // refund.
        if (pay.status === "APPROVED" && orderCaptured) {
          let status = pay.status;
          for (let i = 0; i < 5 && status !== "COMPLETED"; i++) {
            await sleep(1500);
            const re = await sq("GET", `/payments/${p.id}`);
            status = re.json?.payment?.status ?? status;
          }
          paymentStatus.set(p.id, status);
          const amount = pay.amount_money?.amount ?? HALF;
          const r = await sq("POST", "/refunds", {
            idempotency_key: `${KEY}-refund-${p.id.slice(-6)}`,
            payment_id: p.id,
            amount_money: { amount, currency: "USD" },
            reason: "Terminal split probe cleanup",
          });
          console.log(
            `  ${p.label} captured (read ${status}) → refund ${amount}¢ → ${
              r.ok ? `ok refund=${r.json.refund?.id} status=${r.json.refund?.status}` : "FAILED " + errStr(r.json)
            }`,
          );
          if (!r.ok)
            console.log(
              `  MANUAL ACTION: payment ${p.id} — captured ${amount}¢ did not refund; REFUND it manually (cancel is impossible post-capture)`,
            );
        } else if (pay.status === "APPROVED") {
          const r = await sq("POST", `/payments/${p.id}/cancel`, {
            idempotency_key: `${KEY}-cancel-${p.id.slice(-6)}`,
          });
          if (r.ok) paymentStatus.set(p.id, "CANCELED");
          console.log(`  ${p.label} APPROVED → cancel → ${r.ok ? "ok (auth voided)" : "FAILED " + errStr(r.json)}`);
          if (!r.ok) console.log(`  MANUAL ACTION: payment ${p.id} — APPROVED auth did not void; cancel it manually`);
        } else if (pay.status === "COMPLETED") {
          const amount = pay.amount_money?.amount ?? HALF;
          const r = await sq("POST", "/refunds", {
            idempotency_key: `${KEY}-refund-${p.id.slice(-6)}`,
            payment_id: p.id,
            amount_money: { amount, currency: "USD" },
            reason: "Terminal split probe cleanup",
          });
          console.log(
            `  ${p.label} COMPLETED → refund ${amount}¢ → ${
              r.ok ? `ok refund=${r.json.refund?.id} status=${r.json.refund?.status}` : "FAILED " + errStr(r.json)
            }`,
          );
          if (!r.ok) console.log(`  MANUAL ACTION: payment ${p.id} — captured ${amount}¢ did not refund; refund it manually`);
        } else {
          console.log(`  ${p.label} ${pay.status} — no action needed`);
        }
      } catch (e) {
        console.log(`  MANUAL ACTION: payment ${p.id} — cleanup threw (${String(e)}); void/refund it manually if needed`);
      }
    }
    // c) Order: cancel unless some tender's payment is actually CAPTURED.
    //    Voided/canceled tenders do NOT block a cancel attempt.
    if (orderId) {
      try {
        const got = await sq("GET", `/orders/${orderId}`);
        const o = got.json?.order;
        if (!o) {
          console.log(`  MANUAL ACTION: order ${orderId} — could not fetch (${errStr(got.json)}); check its state in the dashboard`);
        } else if (o.state !== "OPEN") {
          console.log(`  probe order state=${o.state} — no cancel`);
        } else {
          let captured = false;
          for (const t of o.tenders ?? []) {
            const pid: string | undefined = t?.payment_id;
            if (!pid) continue;
            let status = paymentStatus.get(pid);
            if (status === undefined) status = (await sq("GET", `/payments/${pid}`)).json?.payment?.status;
            if (status === "COMPLETED") captured = true;
            else if (status === undefined) console.log(`  MANUAL ACTION: payment ${pid} — tender status unfetchable; verify it before trusting the order state`);
          }
          if (captured) {
            console.log(`  MANUAL ACTION: order ${orderId} — order has CAPTURED tender — manual review (verify the refunds above landed)`);
          } else {
            const r = await sq("PUT", `/orders/${orderId}`, {
              order: { location_id: o.location_id, version: o.version, state: "CANCELED" },
            });
            console.log(`  probe order cancelled → ${r.ok ? "ok" : "FAILED " + errStr(r.json)}`);
            if (!r.ok) console.log(`  MANUAL ACTION: order ${orderId} — cancel failed; cancel it manually`);
          }
        }
      } catch (e) {
        console.log(`  MANUAL ACTION: order ${orderId} — cleanup threw (${String(e)}); check/cancel it manually`);
      }
    }
  } catch (e) {
    // Unreachable by design (every unit above is isolated) — absolute backstop
    // so cleanup can never throw past this point.
    console.error("  cleanup aborted unexpectedly:", e);
    for (const ck of checkouts) console.log(`  MANUAL ACTION: terminal checkout ${ck.id} — review in dashboard`);
    for (const p of payments) console.log(`  MANUAL ACTION: payment ${p.id} — review in dashboard`);
    if (orderId) console.log(`  MANUAL ACTION: order ${orderId} — review in dashboard`);
  }
}

// Single exit gate: prints the verdict output exactly once (ran-once guard),
// then exits — so no race between the finally block and a signal/uncaught
// handler can ever print two verdict lines. Callers MUST await cleanup()
// before calling this.
let finished = false;
function finish(code: number, verdictOutput: string): never {
  if (!finished) {
    finished = true;
    console.log(verdictOutput);
  }
  process.exit(code);
}

// Interrupts and uncaught errors: unwind, then exit 2 (INCONCLUSIVE).
// Exit 1 is reachable ONLY as a deliberate NO-GO verdict.
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
  console.log('1. creating $2.00 "Split probe" order…');
  const orderRes = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-order`,
    order: {
      location_id: LOCATION,
      line_items: [
        {
          name: "Split probe",
          quantity: "1",
          base_price_money: { amount: TOTAL, currency: "USD" },
        },
      ],
    },
  });
  if (!orderRes.ok) throw new Error(`order create failed: ${errStr(orderRes.json)}`);
  orderId = orderRes.json.order.id as string;
  console.log(`   order ${orderId} total=${orderRes.json.order.net_amount_due_money?.amount ?? TOTAL}¢`);

  // ── 2. THE PROBED CALL — partial ($1) terminal checkout against the order ─
  console.log("2. terminal checkout A: $1.00 of the $2.00 order (THE PROBED CALL)…");
  const legA = await checkoutLeg("a", orderId, HALF, TOTAL);
  if ("failed" in legA) {
    if (legA.failed === "rejected") {
      verdict = "no-go";
      verdictNote = "Square rejected a partial-amount checkout on an order-linked Terminal checkout (400 referencing amount/total)";
      exitCode = 1;
    } else if (legA.failed === "autocompleted") {
      verdict = "no-go";
      verdictNote = "Terminal ignores autocomplete:false (payment auto-captured) — atomic PayOrder capture impossible";
      exitCode = 1;
    } else if (legA.failed === "coerced") {
      verdict = "no-go";
      verdictNote = "Terminal coerces partial amount to order net due";
      exitCode = 1;
    } else if (legA.failed === "error") {
      verdict = "inconclusive";
      verdictNote = "checkout A failed with a non-verdict error (device/auth/rate-limit/5xx/network) — nothing proven";
      exitCode = 2;
    } else {
      verdict = "inconclusive";
      verdictNote = "checkout A never COMPLETED (timeout/cancel) — nothing proven";
      exitCode = 2;
    }
    throw new Halt();
  }
  console.log("   ✓ partial checkout ACCEPTED and payment A APPROVED (not captured)");

  // ── 3. Second partial checkout for the remaining $1 ───────────────────────
  console.log("3. terminal checkout B: remaining $1.00…");
  const legB = await checkoutLeg("b", orderId, HALF, TOTAL - HALF);
  if ("failed" in legB) {
    if (legB.failed === "rejected") {
      verdict = "no-go";
      verdictNote = "second partial checkout rejected (400 referencing amount/total) — Square won't arm a reader twice against one order";
      exitCode = 1;
    } else if (legB.failed === "autocompleted") {
      verdict = "no-go";
      verdictNote = "Terminal ignores autocomplete:false on the second leg — atomic capture impossible";
      exitCode = 1;
    } else if (legB.failed === "coerced") {
      verdict = "no-go";
      verdictNote = "Terminal coerces partial amount to order net due (second leg)";
      exitCode = 1;
    } else if (legB.failed === "error") {
      verdict = "inconclusive";
      verdictNote = "checkout B failed with a non-verdict error (device/auth/rate-limit/5xx/network) — nothing proven";
      exitCode = 2;
    } else {
      verdict = "inconclusive";
      verdictNote = "checkout B never COMPLETED (timeout/cancel) — nothing proven";
      exitCode = 2;
    }
    throw new Halt();
  }
  console.log("   ✓ payment B APPROVED (not captured)");

  // ── 4. PayOrder — capture both partial payments atomically ────────────────
  console.log("4. PayOrder with both payment_ids…");
  const payOrderBody = {
    idempotency_key: `${KEY}-payorder`,
    payment_ids: [legA.paymentId, legB.paymentId],
  };
  let payOrderRes = await sq("POST", `/orders/${orderId}/pay`, payOrderBody);
  if (!payOrderRes.ok && (payOrderRes.status >= 500 || payOrderRes.status === 0)) {
    // transient (5xx/network) — retry once (same idempotency key) before any verdict
    console.log(`   PayOrder transient failure (HTTP ${payOrderRes.status}) — retrying once…`);
    await sleep(2000);
    payOrderRes = await sq("POST", `/orders/${orderId}/pay`, payOrderBody);
  }
  if (!payOrderRes.ok) {
    console.log(`   ✗ PayOrder failed (HTTP ${payOrderRes.status})`);
    console.log(`   error: ${errStr(payOrderRes.json)}`);
    if (payOrderRes.status === 400) {
      verdict = "no-go";
      verdictNote = "PayOrder refused the two Terminal partial payments (400)";
      exitCode = 1;
    } else {
      verdict = "inconclusive";
      verdictNote = `PayOrder failed with HTTP ${payOrderRes.status} (auth/rate-limit/5xx/network, not a deliberate rejection) — nothing proven`;
      exitCode = 2;
    }
    throw new Halt();
  }
  const finalState = payOrderRes.json.order?.state;
  console.log(`   PayOrder ok — order state=${finalState}`);
  if (finalState === "COMPLETED") {
    orderCaptured = true; // cleanup must REFUND, never void, from here on
    verdict = "go";
    verdictNote = "two partial Terminal checkouts + atomic PayOrder capture work end-to-end";
    exitCode = 0;
  } else {
    verdict = "inconclusive";
    verdictNote = `PayOrder returned 200 but order state=${finalState} (expected COMPLETED) — investigate before building on this`;
    exitCode = 2;
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
    // cleanup() is written to never throw — absolute backstop so the VERDICT
    // print and process.exit below always run.
    console.error("cleanup failed unexpectedly:", e);
  }
}

const guidance =
  verdict === "go"
    ? "→ split-tender kiosk design can use two partial Terminal checkouts + PayOrder"
    : verdict === "no-go"
      ? "→ split tender needs a different rail (single checkout, or SAVE_CARD + CreatePayment)"
      : "→ nothing proven — re-run with a human at the reader";
finish(exitCode, `\nVERDICT: ${verdict.toUpperCase()} — ${verdictNote}\n${guidance}`);
