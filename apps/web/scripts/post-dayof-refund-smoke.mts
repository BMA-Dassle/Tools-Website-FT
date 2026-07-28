/**
 * §8 Tier-3 end-to-end smoke for the post-day-of refund flow.
 *
 * Walks the REAL money chain against REAL Square objects and drives the REAL
 * cascade (buildEditPlan + executeEditCascade) — no mocks:
 *
 *   1. Charge the owner's card on file for a deposit          (Square)
 *   2. Fund an internal custom-GAN gift card from that sale    (Square)
 *   3. Build a TAXED day-of order and pay it from the gift     (Square)
 *      card — held OPEN by a fulfillment (MID) or driven to
 *      COMPLETED (POST)
 *   4. Seed a bowling_reservations row wired to all of it       (Neon)
 *   5. Zero a day-of line through spec.orderLines and run       (cascade)
 *      the REAL cascade with that phase's flag on
 *   6. VERIFY: itemized return order exists and the refund is linked to it;
 *      the deposit leg refunded to the card; the gift card holds nothing; the
 *      Neon row updated; the Payments timeline shows the refund; the History
 *      stream shows the edit
 *   7. Clean up: refund everything, drain + deactivate the card, delete the row
 *
 * MODES (compose freely):
 *   (default)  MID  — order OPEN with a tender, row 'arrived',
 *                     RESERVATION_EDIT_V2_MID_DECREASE
 *   --post     POST — order COMPLETED, row 'completed', managerOverride,
 *                     RESERVATION_EDIT_V2_POST
 *   --race     Seed a RACE row whose day-of order carries ONE collapsed pack
 *              line (how a Rookie Pack actually bills) instead of lane+food,
 *              and refund the whole thing. `--post --race` is the exact shape
 *              of res 16426 — a completed race, one pack line, full refund.
 *
 * Square objects live at the non-accounting location 6MZJFTGAYD7TC. The Neon
 * row is written to the live DB (owner-approved), named clearly as a test,
 * and DELETED in the finally block.
 *
 * DRY RUN by default. From apps/web:
 *   npx tsx scripts/post-dayof-refund-smoke.mts --live
 *   npx tsx scripts/post-dayof-refund-smoke.mts --live --post
 *   npx tsx scripts/post-dayof-refund-smoke.mts --live --post --race
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const LIVE = process.argv.includes("--live");
/** POST = the day-of order is CLOSED (res 16426's phase). Default is MID. */
const POST = process.argv.includes("--post");
/** RACE = one collapsed pack line on the day-of order, refunded in full. */
const RACE = process.argv.includes("--race");
const MODE = `${POST ? "POST" : "MID"}${RACE ? " · RACE PACK (full refund)" : ""}`;

// The cascade reads these at call time — the smoke IS the gate for flipping
// them in production, so turn on EXACTLY the one under test for this process.
//
// RESERVATION_EDIT_V2 (master) is deliberately left OFF: a refund-only plan is
// exempt from it (isRefundOnlyPlan), so a green run proves the refund path needs
// nothing but its phase flag — which is precisely how production is configured.
delete process.env.RESERVATION_EDIT_V2;
process.env[POST ? "RESERVATION_EDIT_V2_POST" : "RESERVATION_EDIT_V2_MID_DECREASE"] = "true";
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const LOCATION = "6MZJFTGAYD7TC";
const OWNER_EMAIL = "eric@headpinz.com";
/**
 * bowling_square_products.center_code is the SQUARE LOCATION ID, not a slug.
 * The row must name a center whose catalog the repricer can resolve, or it
 * fails "no primary lane line". Square objects still live at the probe
 * location — the planner reads the order's own location for charge routing.
 */
const CENTER_CODE = "TXBSQN0FEKQ11";
const PRIMARY_PRODUCT_ID = 19; // "Fun 4 All" @ 1599, per-person
const PRIMARY_LABEL = "Fun 4 All";
const PRIMARY_CENTS = 1599;
const PLAYERS = 2;
/** Rung up outside the booking engine — the line the refund removes. */
const FOOD_LABEL = "Soda (POS)";
const FOOD_CENTS = 600;
/**
 * RACE mode: the day-of order carries ONE line for the whole booking, exactly
 * how a race pack bills (res 16426: "Rookie Pack" ×1 = $27.67). The name must
 * NOT collide with a race-registry product or the seeded reservation line, or
 * isEngineOwnedLine claims it and spec.orderLines refuses — which is precisely
 * the trap this mode exists to prove we avoid.
 */
const PACK_LABEL = "Rookie Pack (SMOKE)";
const PACK_CENTS = 2099;
/** The seeded Neon line: a race product name, mirroring the real row. */
const RACE_LINE_LABEL = "Junior Starter Race Blue";
const KEY = `smk-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log(`=== DRY RUN — mode ${MODE} (pass --live to execute) ===`);
  console.log("Would: charge the owner's card on file (deposit), fund an internal card");
  console.log(
    RACE
      ? `Would: build a taxed day-of order (ONE "${PACK_LABEL}" line) paid by that card`
      : "Would: build a taxed day-of order (lane + soda) paid by that card",
  );
  console.log(
    POST
      ? "Would: drive that order to COMPLETED and seed the row as 'completed' (post_complete)"
      : "Would: hold that order OPEN via a fulfillment and seed the row as 'arrived' (mid)",
  );
  console.log("Would: seed a TEST bowling_reservations row in Neon wired to those ids");
  console.log(
    RACE
      ? "Would: run the REAL cascade zeroing the pack line (FULL refund)"
      : "Would: run the REAL cascade removing the soda line",
  );
  console.log("Would: verify return order + linked refund, card refund, GC drained,");
  console.log("       Neon row, Payments timeline, History stream");
  console.log("Would: refund everything, drain + deactivate the card, DELETE the row");
  process.exit(0);
}
console.log(`=== LIVE — mode ${MODE} ===`);

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
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 300)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name} — ${detail}`);
};

const { neon } = await import("@neondatabase/serverless");
const db = neon(process.env.DATABASE_URL!);

let neonId: number | undefined;
let giftCardId: string | undefined;
let depositPaymentId: string | undefined;
let dayofPaymentId: string | undefined;
let depositCents = 0;
let dayofCents = 0;

try {
  // ── 1. Owner's card on file → deposit sale ───────────────────────────────
  const cust = await sq("POST", "/customers/search", {
    query: { filter: { email_address: { exact: OWNER_EMAIL } } },
    limit: 10,
  });
  let customerId: string | undefined;
  let cardId: string | undefined;
  let cardLabel = "";
  for (const c of cust.json?.customers ?? []) {
    const cards = await sq("GET", `/cards?customer_id=${c.id}`);
    const en = (cards.json?.cards ?? []).find((cd: any) => cd.enabled);
    if (en) {
      customerId = c.id;
      cardId = en.id;
      cardLabel = `${en.card_brand} …${en.last_4}`;
      break;
    }
  }
  if (!customerId || !cardId) throw new Error(`no card on file for ${OWNER_EMAIL}`);
  console.log(`card on file: ${cardLabel}`);

  // Deposit == day-of total (tax-inclusive) — the production invariant.
  const dayofSubtotal = RACE ? PACK_CENTS : PRIMARY_CENTS * PLAYERS + FOOD_CENTS;
  depositCents = Math.round(dayofSubtotal * 1.07);

  const depOrder = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-do`,
    order: {
      location_id: LOCATION,
      customer_id: customerId,
      line_items: [
        {
          name: "Reservation Deposit (SMOKE TEST)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: depositCents, currency: "USD" },
        },
      ],
    },
  });
  if (!depOrder.ok) throw new Error(`deposit order: ${errStr(depOrder)}`);
  const depOrderId = depOrder.json.order.id as string;
  const depLineUid = depOrder.json.order.line_items[0].uid as string;

  const depPay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-dp`,
    source_id: cardId,
    customer_id: customerId,
    amount_money: { amount: depositCents, currency: "USD" },
    order_id: depOrderId,
    location_id: LOCATION,
    autocomplete: true,
    note: "SMOKE TEST — post-day-of refund",
  });
  if (!depPay.ok) throw new Error(`deposit charge: ${errStr(depPay)}`);
  depositPaymentId = depPay.json.payment.id as string;
  console.log(`deposit ${depositCents}¢ charged to ${cardLabel} — ${depositPaymentId}`);

  // ── 2. Internal custom-GAN card funded by that sale ──────────────────────
  const gan = `WEBSMK${Date.now().toString().slice(-10)}`;
  const gcCreate = await sq("POST", "/gift-cards", {
    idempotency_key: `${KEY}-gc`,
    location_id: LOCATION,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan },
  });
  if (!gcCreate.ok) throw new Error(`gift card: ${errStr(gcCreate)}`);
  giftCardId = gcCreate.json.gift_card.id as string;
  const gcAct = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-ga`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION,
      gift_card_id: giftCardId,
      activate_activity_details: { order_id: depOrderId, line_item_uid: depLineUid },
    },
  });
  if (!gcAct.ok) throw new Error(`activate: ${errStr(gcAct)}`);
  console.log(`internal card ${gan} funded ${depositCents}¢`);

  // ── 3. Taxed day-of order, paid by the card ──────────────────────────────
  // MID keeps it OPEN with a PROPOSED fulfillment (Square will not auto-close a
  // paid order that still owes fulfillment). POST omits that so paying it in
  // full closes it — the state the post_complete path is defined by.
  const lineItems = RACE
    ? [
        {
          uid: "PACK",
          name: PACK_LABEL,
          quantity: "1",
          base_price_money: { amount: PACK_CENTS, currency: "USD" },
        },
      ]
    : [
        {
          uid: "LANE",
          name: PRIMARY_LABEL,
          quantity: String(PLAYERS),
          base_price_money: { amount: PRIMARY_CENTS, currency: "USD" },
        },
        {
          uid: "FOOD",
          name: FOOD_LABEL,
          quantity: "1",
          base_price_money: { amount: FOOD_CENTS, currency: "USD" },
        },
      ];
  const dayof = await sq("POST", "/orders", {
    idempotency_key: `${KEY}-yo`,
    order: {
      location_id: LOCATION,
      line_items: lineItems,
      taxes: [{ uid: "TX", name: "Sales tax", percentage: "7", scope: "ORDER" }],
      ...(POST
        ? {}
        : {
            fulfillments: [
              {
                type: "PICKUP",
                state: "PROPOSED",
                pickup_details: {
                  recipient: { display_name: "SMOKE TEST" },
                  schedule_type: "ASAP",
                },
              },
            ],
          }),
    },
  });
  if (!dayof.ok) throw new Error(`day-of order: ${errStr(dayof)}`);
  const dayofOrderId = dayof.json.order.id as string;
  dayofCents = dayof.json.order.total_money?.amount ?? 0;
  /** The line the refund zeroes: the whole pack (RACE) or just the soda. */
  const targetName = RACE ? PACK_LABEL : FOOD_LABEL;
  const targetUid = dayof.json.order.line_items.find((l: any) => l.name === targetName)?.uid;
  if (!targetUid) throw new Error(`could not locate the "${targetName}" line uid`);

  const dayofPay = await sq("POST", "/payments", {
    idempotency_key: `${KEY}-yp`,
    source_id: giftCardId,
    amount_money: { amount: dayofCents, currency: "USD" },
    order_id: dayofOrderId,
    location_id: LOCATION,
    autocomplete: true,
  });
  if (!dayofPay.ok) throw new Error(`day-of payment: ${errStr(dayofPay)}`);
  dayofPaymentId = dayofPay.json.payment.id as string;

  let dayofState = (await sq("GET", `/orders/${dayofOrderId}`)).json?.order?.state;
  if (POST && dayofState !== "COMPLETED") {
    // Paying in full usually closes a fulfillment-free order; force it if not,
    // so the phase under test is unambiguous rather than accidental.
    const cur = (await sq("GET", `/orders/${dayofOrderId}`)).json?.order;
    const done = await sq("PUT", `/orders/${dayofOrderId}`, {
      idempotency_key: `${KEY}-yc`,
      order: { location_id: LOCATION, version: cur.version, state: "COMPLETED" },
    });
    if (!done.ok) throw new Error(`could not close the day-of order: ${errStr(done)}`);
    dayofState = done.json.order.state;
  }
  if (POST && dayofState !== "COMPLETED") {
    throw new Error(`POST mode needs a COMPLETED day-of order, got ${dayofState}`);
  }
  if (!POST && dayofState !== "OPEN") {
    throw new Error(`MID mode needs an OPEN day-of order, got ${dayofState}`);
  }
  console.log(
    `day-of order ${dayofOrderId} ${dayofCents}¢ paid from the card — state=${dayofState}, ` +
      `target line "${targetName}" uid=${targetUid}`,
  );

  // ── 4. Seed the reservation row (clearly a test; deleted in cleanup) ─────
  const bookedAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString();
  const ins = (await db`
    INSERT INTO bowling_reservations (
      center_code, product_kind,
      square_deposit_order_id, square_deposit_payment_id, square_dayof_order_id,
      square_gift_card_id, square_gift_card_gan,
      deposit_cents, total_cents, status, booked_at, player_count,
      guest_name, guest_email, booking_source, square_customer_id,
      dayof_order_sent_at, dayof_payment_id, booking_metadata
    ) VALUES (
      ${RACE ? "fort-myers" : CENTER_CODE}, ${RACE ? "race" : "open"},
      ${depOrderId}, ${depositPaymentId}, ${dayofOrderId},
      ${giftCardId}, ${gan},
      ${depositCents}, ${dayofCents}, ${POST ? "completed" : "arrived"}, ${bookedAt}, ${PLAYERS},
      'ZZ SMOKE TEST — post-dayof refund', ${OWNER_EMAIL}, 'smoke-test', ${customerId},
      NOW(), ${dayofPaymentId},
      ${JSON.stringify(
        RACE
          ? // No bmi_bill_id is seeded, so raceLegPlan skips its bmiLineId
            // refusal — this smoke proves the MONEY path, never BMI (which
            // post_complete explicitly does not touch).
            { heats: [{ assignedTo: "ZZ Smoke Racer", category: "junior", heatId: null }] }
          : {
              bowling: {
                experienceSlug: null,
                laneCount: 1,
                durationMultiplier: 1,
                pricingMode: "per_person",
              },
            },
      )}::jsonb
    ) RETURNING id
  `) as Array<{ id: number }>;
  neonId = Number(ins[0].id);
  // The repricer resolves the PRIMARY from the reservation's own lines. The race
  // variant mirrors the real row: a race-product label with NO square_product_id,
  // which is what leaves the collapsed pack line un-owned by the engine.
  if (RACE) {
    await db`
      INSERT INTO bowling_reservation_lines
        (reservation_id, square_product_id, label, quantity, unit_price_cents)
      VALUES (${neonId}, NULL, ${RACE_LINE_LABEL}, 1, ${PACK_CENTS})
    `;
  } else {
    await db`
      INSERT INTO bowling_reservation_lines
        (reservation_id, square_product_id, label, quantity, unit_price_cents)
      VALUES (${neonId}, ${PRIMARY_PRODUCT_ID}, ${PRIMARY_LABEL}, ${PLAYERS}, ${PRIMARY_CENTS})
    `;
  }
  console.log(
    `seeded reservation ${neonId} (kind=${RACE ? "race" : "open"}, ` +
      `status=${POST ? "completed" : "arrived"}, dayof paid)`,
  );

  // ── 5. Run the REAL cascade: remove the pizza line ───────────────────────
  const { buildEditPlan } = await import("../src/features/reservation-edit/plan");
  const { executeEditCascade } = await import("../src/features/reservation-edit/service");
  const { isRefundOnlyPlan } = await import("../src/features/reservation-edit/guards");

  const plan = await buildEditPlan({
    neonId,
    spec: { orderLines: { [targetUid]: 0 } },
    // post_complete refuses to plan without the manager acknowledgment; the
    // modal collects it via the checkbox before it ever reaches this call.
    managerOverride: POST,
  });
  console.log(
    `\nplan: phase=${plan.phase} diff=${plan.diffCents}¢ guestOwed=${plan.guestOwedCents}¢ ` +
      `gcDecrement=${plan.gcDecrementCents}¢`,
  );
  console.log(`plan steps: ${plan.steps.map((s) => s.kind).join(" → ")}`);
  check(
    `plan phase is ${POST ? "post_complete" : "mid"}`,
    plan.phase === (POST ? "post_complete" : "mid"),
    plan.phase,
  );
  check(
    "plan may execute on its PHASE flag alone (master switch is OFF)",
    plan.executionBlocked === null && process.env.RESERVATION_EDIT_V2 !== "true",
    plan.executionBlocked
      ? `blocked: ${plan.executionBlocked.code}`
      : `executionBlocked=null, RESERVATION_EDIT_V2=${process.env.RESERVATION_EDIT_V2 ?? "unset"}`,
  );
  check(
    "plan is refund-only (exempt from the master switch)",
    isRefundOnlyPlan(plan),
    plan.steps.map((s) => s.kind).join(" → "),
  );
  if (POST) {
    check(
      "manager warning present (QAMF/BMI not updated)",
      plan.warnings.some((w) => w.severity === "manager"),
      plan.warnings.map((w) => `${w.severity}:${w.code}`).join(", ") || "none",
    );
  }
  if (RACE) {
    check(
      "full refund — the pack line is the whole order",
      plan.legs[0].newTotalCents === 0 && plan.diffCents === -dayofCents,
      `newTotal=${plan.legs[0].newTotalCents} diff=${plan.diffCents} (order was ${dayofCents})`,
    );
  }
  check(
    "plan is money-only (no line update on a paid order)",
    !plan.steps.some((s) => s.kind === "update_dayof_order"),
    plan.steps.some((s) => s.kind === "update_dayof_order") ? "emitted one" : "none emitted",
  );
  check(
    "plan reconciles the gift card (no async wait)",
    plan.steps.some((s) => s.kind === "reconcile_gift_card") &&
      !plan.steps.some((s) => s.kind === "adjust_gift_card_down"),
    plan.steps.map((s) => s.kind).join(" → "),
  );
  check(
    "plan identified the returned line",
    plan.legs[0].returnedLines.length === 1 && plan.legs[0].returnedLines[0].uid === targetUid,
    JSON.stringify(plan.legs[0].returnedLines),
  );

  console.log("\nexecuting cascade…");
  const result = await executeEditCascade({
    plan,
    settlement: "card_refund",
    notifyGuest: false,
    actor: "smoke-test",
    origin: "https://localhost",
    dayofRefundReason: "Smoke test — pizza returned unmade",
  });
  console.log(`cascade ${result.state}: ${result.stepLog.map((s) => s.step).join(" → ")}`);
  for (const s of result.stepLog) {
    if (!s.ok) console.log(`  step FAILED: ${s.step} ${s.detail ?? ""}`);
  }

  // ── 6. Verify ────────────────────────────────────────────────────────────
  console.log("\n— verification —");
  check("cascade completed", result.state === "completed", result.state);

  const refundIds = result.refundIds;
  check(
    "two refunds issued (day-of leg + deposit leg)",
    refundIds.length >= 2,
    refundIds.join(", "),
  );

  // Itemized: the day-of refund must carry an order_id pointing at a RETURN order.
  let itemized = false;
  let returnDetail = "no refund carried an order_id with returns[]";
  for (const rid of refundIds) {
    const rf = (await sq("GET", `/refunds/${rid}`)).json?.refund;
    if (!rf?.order_id) continue;
    const ord = (await sq("GET", `/orders/${rf.order_id}`)).json?.order;
    const rl = ord?.returns?.[0]?.return_line_items ?? [];
    if (rl.length > 0) {
      itemized = true;
      returnDetail =
        `refund ${rid.slice(0, 12)}… → return order ${rf.order_id.slice(0, 12)}… ` +
        `returning ${rl.length} line(s), source uid ${rl[0].source_line_item_uid}, ` +
        `total ${ord?.return_amounts?.total_money?.amount}¢`;
      break;
    }
  }
  check("day-of refund is ITEMIZED against a return order", itemized, returnDetail);

  const depAfter = (await sq("GET", `/payments/${depositPaymentId}`)).json?.payment;
  check(
    "deposit refunded to the guest's card",
    (depAfter?.refunded_money?.amount ?? 0) > 0,
    `${depAfter?.refunded_money?.amount ?? 0}¢ back to ${cardLabel}`,
  );

  await sleep(4000);
  const gcAfter = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
  check(
    "internal gift card holds no leftover value",
    (gcAfter?.balance_money?.amount ?? 0) === 0,
    `balance ${gcAfter?.balance_money?.amount ?? 0}¢ (credit came back then was decremented)`,
  );

  // The paid order keeps its items forever ("LineItems cannot be modified for
  // finalized tenders") — the refunds carry the story. Prove we left it alone.
  //
  // NOTE: an ITEMIZED refund does NOT populate the SALE order's `refunds[]`.
  // The refund's order_id points at the RETURN order, so that is where the
  // linkage lives (asserted above). Staff reading the sale order in Square see
  // it via `return_amounts` / the linked return, and the Payments tab reads the
  // edit ledger + live refund facts rather than `order.refunds`.
  const orderAfter = (await sq("GET", `/orders/${dayofOrderId}`)).json?.order;
  check(
    "day-of order LINES + state untouched (frozen after payment)",
    orderAfter?.state === dayofState && (orderAfter?.line_items?.length ?? 0) === lineItems.length,
    `state=${orderAfter?.state} lines=${orderAfter?.line_items?.length} ` +
      `refunds_on_sale_order=${orderAfter?.refunds?.length ?? 0} ` +
      `refunded_money=${orderAfter?.refunded_money?.amount ?? 0} ` +
      `net_due=${orderAfter?.net_amount_due_money?.amount ?? 0}`,
  );

  const rows = (await db`
    SELECT total_cents, status, refund_cents, square_dayof_order_id
    FROM bowling_reservations WHERE id = ${neonId}
  `) as Array<Record<string, unknown>>;
  check(
    "reservation NOT marked cancelled — the visit happened",
    rows[0]?.status !== "cancelled" && rows[0]?.status === (POST ? "completed" : "arrived"),
    `status=${rows[0]?.status}`,
  );
  // Race legs keep their Neon lines (BMI owns race pricing), so total_cents is
  // deliberately unchanged there and the refund lives in the edit ledger.
  // Bowling legs are repriced by commitNeon.
  check(
    RACE
      ? "race leg keeps its Neon lines (BMI-owned pricing)"
      : "Neon row repriced down by the refund",
    RACE ? Number(rows[0]?.total_cents) === dayofCents : Number(rows[0]?.total_cents) < dayofCents,
    `total_cents=${rows[0]?.total_cents} (order was ${dayofCents})`,
  );
  // A money-only refund must NOT re-point the order — only a rebuild does.
  check(
    "day-of order pointer unchanged (no rebuild happened)",
    rows[0]?.square_dayof_order_id === dayofOrderId,
    String(rows[0]?.square_dayof_order_id).slice(0, 14) + "…",
  );
  check(
    "refund_cents left alone (cancellation-only column)",
    Number(rows[0]?.refund_cents ?? 0) === 0,
    `refund_cents=${rows[0]?.refund_cents}`,
  );

  const { getPaymentTimeline, getReservationDetail } =
    await import("../src/features/reservations-admin/service");
  const tl = await getPaymentTimeline(neonId);
  const refundsNode = tl?.nodes.find((n) => n.kind === "refunds");
  check(
    "Payments tab surfaces the refunds",
    (refundsNode?.refunds?.length ?? 0) >= 2,
    refundsNode?.refunds?.map((r) => `${r.amountCents}¢ ${r.status}`).join(", ") ?? "none",
  );

  const detail = await getReservationDetail({ id: neonId });
  const editEntry = detail?.history.find((h) => h.source === "edit");
  check(
    "History tab surfaces the edit",
    !!editEntry,
    editEntry ? `edit entry at ${editEntry.at}` : "no edit entry",
  );
} catch (e) {
  console.log(`\nSMOKE ABORTED: ${e instanceof Error ? e.message : e}`);
  checks.push({ name: "ran to completion", pass: false, detail: String(e) });
} finally {
  console.log("\n— cleanup —");
  for (const [label, pid, amt] of [
    ["day-of", dayofPaymentId, dayofCents],
    ["deposit", depositPaymentId, depositCents],
  ] as Array<[string, string | undefined, number]>) {
    if (!pid) continue;
    const p = (await sq("GET", `/payments/${pid}`)).json?.payment;
    const rest = amt - (p?.refunded_money?.amount ?? 0);
    if (rest > 0) {
      const r = await sq("POST", "/refunds", {
        idempotency_key: `${KEY}-cz-${label}`,
        payment_id: pid,
        amount_money: { amount: rest, currency: "USD" },
        reason: "Refund: Reservation Deposit",
      });
      console.log(`${label} remainder ${rest}¢ → ${r.ok ? "ok" : errStr(r)}`);
    }
  }
  if (giftCardId) {
    let bal = 0;
    let last = -1;
    for (let i = 0; i < 24; i++) {
      bal =
        (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card?.balance_money?.amount ?? 0;
      if (bal === last) break;
      last = bal;
      await sleep(5000);
    }
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
    const st = (await sq("GET", `/gift-cards/${giftCardId}`)).json?.gift_card;
    if (st?.state === "ACTIVE" && (st?.balance_money?.amount ?? 0) === 0) {
      await sq("POST", "/gift-cards/activities", {
        idempotency_key: `${KEY}-deact`,
        gift_card_activity: {
          type: "DEACTIVATE",
          location_id: LOCATION,
          gift_card_id: giftCardId,
          deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
        },
      });
      console.log("gift card deactivated");
    }
  }
  if (neonId) {
    // Children first — bowling_reservation_lines has an FK to the row.
    await db`DELETE FROM reservation_edit_events WHERE anchor_reservation_id = ${neonId}`;
    await db`DELETE FROM bowling_reservation_players WHERE reservation_id = ${neonId}`;
    await db`DELETE FROM bowling_reservation_lines WHERE reservation_id = ${neonId}`;
    await db`DELETE FROM bowling_reservations WHERE id = ${neonId}`;
    console.log(`deleted test reservation ${neonId} + children`);
  }
}

console.log("\n═══ SMOKE RESULT ═══");
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
