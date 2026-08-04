/**
 * CONTROL for unlinked-refund-soda-probe.mts (2026-07-28).
 *
 * That probe's card-on-file unlinked refund came back REFUND_DECLINED. The
 * request shape was correct per Square's own docs (unlinked:true +
 * destination_id + customer_id for card-on-file + location_id, no payment_id),
 * so the decline is one of exactly two things:
 *
 *   (a) the seller-level unlinked-refund ENTITLEMENT is still off, or
 *   (b) the entitlement is on and the push-to-card to VISA …5214 declined.
 *
 * Same symptom, opposite next actions — (a) means call Square back, (b) means
 * try another card. CASH and EXTERNAL unlinked refunds ride the SAME seller
 * entitlement but move no card money at all, so they separate the two:
 *
 *   C1  unlinked refund, destination_id = "CASH"      → no card push
 *   C2  unlinked refund, destination_id = "EXTERNAL"  → no card push
 *
 * If C1/C2 are ACCEPTED, entitlement is ON and the card is the problem.
 * If C1/C2 are DECLINED the same way, entitlement is OFF — Square has not
 * flipped it, whatever the rep said.
 *
 * Non-accounting location. Amounts are one soda (400¢) so the recorded figure
 * matches the sibling probe. Reason is the owner-mandated exact string.
 *
 * Run from apps/web:
 *   npx tsx scripts/unlinked-refund-entitlement-control.mts          # dry run
 *   npx tsx scripts/unlinked-refund-entitlement-control.mts --live
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
const CENTS = 400;
const REASON = "Refund: Reservation Deposit";
const KEY = `unlc-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log(`Would attempt two unlinked refunds of ${CENTS}¢ at ${LOCATION}:`);
  console.log('  C1  destination_id = "CASH"      (records a cash-back, no card push)');
  console.log('  C2  destination_id = "EXTERNAL"  (records an external refund, no card push)');
  console.log("No card money moves either way. Purpose: entitlement vs card decline.");
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
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 400)}`;
const codes = (r: { json: any }) =>
  (r.json?.errors ?? []).map((e: any) => `${e.category}/${e.code}`).join(",") || "-";

const results: Array<[string, boolean, string]> = [];

// ── C1: CASH ────────────────────────────────────────────────────────────────
const c1 = await sq("POST", "/refunds", {
  idempotency_key: `${KEY}-cash`,
  unlinked: true,
  destination_id: "CASH",
  location_id: LOCATION,
  amount_money: { amount: CENTS, currency: "USD" },
  reason: REASON,
  cash_details: {
    buyer_supplied_money: { amount: CENTS, currency: "USD" },
  },
});
results.push([
  'C1 unlinked refund destination_id="CASH"',
  c1.ok,
  c1.ok
    ? `ACCEPTED — refund ${c1.json.refund?.id} status=${c1.json.refund?.status} ` +
      `order_id=${c1.json.refund?.order_id ?? "none"}`
    : `REFUSED — ${codes(c1)} — ${errStr(c1)}`,
]);

// ── C2: EXTERNAL ────────────────────────────────────────────────────────────
const c2 = await sq("POST", "/refunds", {
  idempotency_key: `${KEY}-ext`,
  unlinked: true,
  destination_id: "EXTERNAL",
  location_id: LOCATION,
  amount_money: { amount: CENTS, currency: "USD" },
  reason: REASON,
  external_details: {
    type: "OTHER",
    source: "FastTrax probe",
  },
});
results.push([
  'C2 unlinked refund destination_id="EXTERNAL"',
  c2.ok,
  c2.ok
    ? `ACCEPTED — refund ${c2.json.refund?.id} status=${c2.json.refund?.status} ` +
      `order_id=${c2.json.refund?.order_id ?? "none"}`
    : `REFUSED — ${codes(c2)} — ${errStr(c2)}`,
]);

for (const [q, , a] of results) console.log(`\n>>> ${q}\n    ${a}`);

const anyOk = results.some(([, ok]) => ok);
console.log("\n═══ VERDICT ═══");
console.log(
  anyOk
    ? "A non-card unlinked refund was ACCEPTED → the seller-level entitlement IS ON. " +
        "The card-on-file decline is a PUSH-TO-CARD failure, not a permission problem — " +
        "retry with a different card / ask Square why the OCT to VISA …5214 declined."
    : "Every unlinked refund shape was refused → the seller-level entitlement is still OFF. " +
        "Finding G5 stands. Square has not actually enabled it on this account; go back to the " +
        "rep with these error codes and the timestamps.",
);
