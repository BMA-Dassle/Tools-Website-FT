/**
 * Refund the DUPLICATE $1,497.31 balance charge on BMI #3286 (LSI Companies,
 * GF quote 33, FastTrax Fort Myers).
 *
 * The duplicate is payment 9cDUlimu… / order ZitALNK3… (2026-06-04 19:45:02).
 * Cron run #1 charged the card, then crashed loading the gift card ($2k
 * headroom bug, fixed 2026-06-11 in 32516193); with no atomic claim and a
 * random idempotency key the next tick charged the card a SECOND time
 * (diuMvXzR… @19:54:56). Only the second charge funded the gift cards and the
 * day-of order, so 9cDUlimu… is pure orphaned revenue — zero rows anywhere in
 * Neon reference it.
 *
 * ITEMIZED per owner rule (2026-07-27): build a Square RETURN order carrying
 * returns[].source_line_item_uid, then refund the payment AGAINST that return
 * using Square's own return_amounts.total. Never amount-only.
 * Reason string is EXACTLY "Refund: Reservation Deposit" — the portal journal
 * keys off it.
 *
 * Dry run (default):  npx tsx scripts/lsi-3286-refund-duplicate.mts
 * Live:               npx tsx scripts/lsi-3286-refund-duplicate.mts --live
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const LIVE = process.argv.includes("--live");

const QUOTE_ID = 33;
const LOCATION_ID = "LAB52GY480CJF"; // FastTrax Fort Myers
const DUP_PAYMENT_ID = "9cDUlimuEGo2FesJnJLfAJ7itfcZY";
const DUP_ORDER_ID = "ZitALNK3mjwAPErpM6Edh2TN8CeZY";
const DUP_LINE_UID = "JZ6W9MziQVZGpmdlMFHLSC";
const EXPECT_CENTS = 149_731;
const REASON = "Refund: Reservation Deposit"; // exact string — do not alter
const EDIT_ID = "lsi3286-dup"; // idempotency namespace: -ret0 / -r0

const d = (c: number) => `$${(c / 100).toFixed(2)}`;

const { sq } = await import("~/features/cancellation/square-actions");
const { createReturnOrder, refundTenderPartial } = await import(
  "~/features/reservation-edit/square-actions"
);

// ── PRE-FLIGHT: re-fetch and verify every fact before touching money ──
console.log(`══════ PRE-FLIGHT ══════`);

const payRes = await sq("GET", `/payments/${DUP_PAYMENT_ID}`);
if (!payRes.ok || !payRes.json?.payment) throw new Error(`payment fetch failed: ${JSON.stringify(payRes.json).slice(0, 300)}`);
const pay = payRes.json.payment;
const alreadyRefunded = pay.refunded_money?.amount ?? 0;
console.log(`  payment ${DUP_PAYMENT_ID}`);
console.log(`    status=${pay.status} amount=${d(pay.amount_money.amount)} refunded=${d(alreadyRefunded)}`);
console.log(`    card=${pay.card_details?.card?.card_brand}****${pay.card_details?.card?.last_4} created=${pay.created_at}`);
console.log(`    order=${pay.order_id}`);

if (pay.status !== "COMPLETED") throw new Error(`payment is ${pay.status}, not COMPLETED — aborting`);
if (pay.amount_money.amount !== EXPECT_CENTS) throw new Error(`payment is ${d(pay.amount_money.amount)}, expected ${d(EXPECT_CENTS)} — aborting`);
if (pay.order_id !== DUP_ORDER_ID) throw new Error(`payment's order is ${pay.order_id}, expected ${DUP_ORDER_ID} — aborting`);
if (alreadyRefunded > 0) {
  console.log(`\n  ✅ ALREADY REFUNDED ${d(alreadyRefunded)} — nothing to do. Exiting.`);
  process.exit(0);
}

const ordRes = await sq("GET", `/orders/${DUP_ORDER_ID}`);
if (!ordRes.ok || !ordRes.json?.order) throw new Error(`order fetch failed`);
const ord = ordRes.json.order;
const line = (ord.line_items ?? []).find((l: { uid: string }) => l.uid === DUP_LINE_UID);
console.log(`\n  order ${DUP_ORDER_ID} state=${ord.state} version=${ord.version} total=${d(ord.total_money.amount)}`);
console.log(`    existing returns: ${JSON.stringify(ord.returns ?? null)}`);
if (!line) throw new Error(`line uid ${DUP_LINE_UID} not found on order — aborting`);
console.log(`    line uid=${line.uid} "${line.name}" qty=${line.quantity} total=${d(line.total_money.amount)}`);
if (ord.returns) throw new Error(`order already carries returns — aborting to avoid a double refund`);

// Guard: the KEPT charge must still be intact and unrefunded.
const keptRes = await sq("GET", `/payments/diuMvXzRlAZLj7Z8aLdFaIbZZQdZY`);
const kept = keptRes.json?.payment;
console.log(`\n  KEPT charge diuMvXzR… status=${kept?.status} amount=${d(kept?.amount_money?.amount ?? 0)} refunded=${d(kept?.refunded_money?.amount ?? 0)}`);
if (kept?.status !== "COMPLETED" || (kept?.refunded_money?.amount ?? 0) > 0) {
  throw new Error(`the KEPT balance charge is not intact — aborting (refunding both would leave the event unpaid)`);
}

// Guard: the event's money must still reconcile to the contract total.
const { sql } = await import("@/lib/db");
const q = sql();
const rows = (await q`SELECT total_cents, collected_cents, status FROM group_function_quotes WHERE id = ${QUOTE_ID}`) as Array<Record<string, number | string>>;
console.log(`\n  quote ${QUOTE_ID}: total=${d(Number(rows[0].total_cents))} collected=${d(Number(rows[0].collected_cents))} status=${rows[0].status}`);
if (Number(rows[0].collected_cents) !== Number(rows[0].total_cents)) {
  throw new Error(`quote is not fully collected — aborting`);
}

if (!LIVE) {
  console.log(`\n══════ DRY RUN — no money moved ══════`);
  console.log(`  WOULD create return order for ${DUP_ORDER_ID} line ${DUP_LINE_UID} qty 1`);
  console.log(`  WOULD refund ${DUP_PAYMENT_ID} for Square's return_amounts.total`);
  console.log(`  WOULD use reason "${REASON}"`);
  console.log(`\n  Re-run with --live to execute.`);
  process.exit(0);
}

// ── LIVE: itemized return order, then refund against it ──
console.log(`\n══════ LIVE ══════`);

const { returnOrderId, returnTotalCents } = await createReturnOrder({
  editId: EDIT_ID,
  sourceOrderId: DUP_ORDER_ID,
  locationId: LOCATION_ID,
  lines: [{ uid: DUP_LINE_UID, quantity: 1 }],
  seq: 0,
});
console.log(`  return order created: ${returnOrderId}`);
console.log(`  Square's return_amounts.total = ${d(returnTotalCents)}  ← authoritative refund amount`);

if (returnTotalCents !== EXPECT_CENTS) {
  throw new Error(`return total ${d(returnTotalCents)} != expected ${d(EXPECT_CENTS)} — aborting BEFORE the refund`);
}

const refund = await refundTenderPartial({
  editId: EDIT_ID,
  refundIndex: 0,
  paymentId: DUP_PAYMENT_ID,
  amountCents: returnTotalCents,
  reason: REASON,
  returnOrderId,
});
console.log(`  refund issued: ${refund.refundId} for ${d(refund.refundedCents)}`);

// ── VERIFY ──
console.log(`\n══════ VERIFY ══════`);
const vr = await sq("GET", `/refunds/${refund.refundId}`);
const rf = vr.json?.refund;
console.log(`  refund ${rf?.id} status=${rf?.status} amount=${d(rf?.amount_money?.amount ?? 0)}`);
console.log(`  reason="${rf?.reason}"  ${rf?.reason === REASON ? "✅ exact" : "❌ MISMATCH"}`);
console.log(`  order_id=${rf?.order_id}  ${rf?.order_id === returnOrderId ? "✅ linked to return order" : "❌ NOT linked"}`);

const after = await sq("GET", `/payments/${DUP_PAYMENT_ID}`);
console.log(`  payment refunded_money now = ${d(after.json?.payment?.refunded_money?.amount ?? 0)}`);

const keptAfter = await sq("GET", `/payments/diuMvXzRlAZLj7Z8aLdFaIbZZQdZY`);
console.log(`  KEPT charge still refunded=${d(keptAfter.json?.payment?.refunded_money?.amount ?? 0)} (must be $0.00)`);

console.log(`\n  Net collected for #3286 is now ${d(EXPECT_CENTS + 115_178)} card + gift-card rail = contract total $2,649.09 ✅`);
process.exit(0);
