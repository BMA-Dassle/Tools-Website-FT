/**
 * Follow-up to gc-refund-probe.mts (run gcrp KEY, 2026-07-27):
 *
 *  1. STATUS — the two GC-payment refunds were PENDING when cleanup
 *     deactivated the gift card. Verify where the $2 landed: refund statuses,
 *     gift card state + balance. If value is stranded on the deactivated
 *     card, try to drain it (ADJUST_DECREMENT) and report.
 *  2. PROBE B RETRY — the unlinked refund was rejected with "customer_id must
 *     be present when supplying customer payment on file", NOT an entitlement
 *     error. Retry with customer_id to get the real entitlement answer.
 *     If enabled, $1.00 lands on the owner's VISA (owner-authorized).
 *
 * Run from apps/web:  npx tsx scripts/gc-refund-probe-followup.mts --live
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
// Owner rule (2026-07-27): probes ALWAYS use this location — it does not
// track accounting. NEVER probe against a revenue location. (The one probe
// object this script references — the first-run gift card — lives at the old
// Fort Myers location; reads work account-wide.)
const LOCATION = "6MZJFTGAYD7TC";

// Objects from the 2026-07-27 gcrp run (see script output in session log):
const GIFT_CARD_ID = "gftc:53a7edf0904e4dc684c0945ec0080ec9";
const GC_PAYMENT_ID = "FExc6mT59GNQJyOghW5Cw6AekACZY"; // $2 GC-funded spend payment
const PURCHASE_PAYMENT_ID = "JEcUXA3Onub0CxLHvGMvGjQUuQYZY"; // $2 VISA purchase payment
const CUSTOMER_ID = "ABRRYRM2HH2BNFBK2FQ16V2ZDG";
const CARD_ON_FILE_ID_LOOKUP = true; // re-resolve the card id fresh
const OWNER_EMAIL = "eric@headpinz.com";
const UNLINKED_CENTS = 100;
const KEY = `gcrf-${randomUUID().slice(0, 8)}`;

if (!LIVE) {
  console.log("=== DRY RUN (pass --live to execute) ===");
  console.log("Would: GET gift card, GC payment, purchase payment — statuses + balances");
  console.log("Would: if value stranded on the deactivated card, ADJUST_DECREMENT it");
  console.log("Would: retry UNLINKED $1 refund WITH customer_id ← the real entitlement answer");
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
    /* empty body */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}
const errStr = (r: { status: number; json: any }): string =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 400)}`;

// ── 1. Status sweep ──────────────────────────────────────────────────────────
console.log("═══ STATUS ═══");
const gc = await sq("GET", `/gift-cards/${GIFT_CARD_ID}`);
const card = gc.json?.gift_card;
console.log(`gift card: state=${card?.state} balance=${card?.balance_money?.amount ?? "?"}¢`);

for (const [label, pid] of [
  ["GC spend payment", GC_PAYMENT_ID],
  ["VISA purchase payment", PURCHASE_PAYMENT_ID],
] as const) {
  const p = await sq("GET", `/payments/${pid}`);
  console.log(
    `${label}: status=${p.json?.payment?.status} amount=${p.json?.payment?.amount_money?.amount}¢ ` +
      `refunded=${p.json?.payment?.refunded_money?.amount ?? 0}¢`,
  );
}

// Recent activities on the card tell us whether the REFUND activities landed.
const acts = await sq("GET", `/gift-cards/activities?gift_card_id=${GIFT_CARD_ID}&limit=20`);
for (const a of acts.json?.gift_card_activities ?? []) {
  console.log(
    `  activity: ${a.type} ${a.created_at} balance_after=${a.gift_card_balance_money?.amount ?? "?"}¢`,
  );
}

// Drain if anything is stranded.
const bal = card?.balance_money?.amount ?? 0;
if (bal > 0) {
  const d = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${KEY}-drain`,
    gift_card_activity: {
      type: "ADJUST_DECREMENT",
      location_id: LOCATION,
      gift_card_id: GIFT_CARD_ID,
      adjust_decrement_activity_details: {
        amount_money: { amount: bal, currency: "USD" },
        reason: "PURCHASE_WAS_REFUNDED",
      },
    },
  });
  console.log(`stranded ${bal}¢ on ${card?.state} card — drain → ${d.ok ? "ok" : errStr(d)}`);
} else {
  console.log("no stranded balance on the probe card");
}

// ── 2. PROBE B retry with customer_id ────────────────────────────────────────
console.log("\n═══ PROBE B RETRY (with customer_id) ═══");
let cardOnFileId: string | undefined;
if (CARD_ON_FILE_ID_LOOKUP) {
  const cards = await sq("GET", `/cards?customer_id=${CUSTOMER_ID}`);
  const enabled = (cards.json?.cards ?? []).find((cd: any) => cd.enabled);
  cardOnFileId = enabled?.id;
  console.log(`card on file: ${enabled?.card_brand} …${enabled?.last_4} (${cardOnFileId})`);
}
if (!cardOnFileId) {
  console.log(`no enabled card on file for ${OWNER_EMAIL} — cannot retry`);
  process.exit(2);
}
const unlinked = await sq("POST", "/refunds", {
  idempotency_key: `${KEY}-u1`,
  unlinked: true,
  destination_id: cardOnFileId,
  customer_id: CUSTOMER_ID,
  amount_money: { amount: UNLINKED_CENTS, currency: "USD" },
  location_id: LOCATION,
  reason: "Refund: Reservation Deposit",
});
console.log(`unlinked $1 refund → ${unlinked.ok ? "ACCEPTED" : errStr(unlinked)}`);
console.log(
  unlinked.ok
    ? `VERDICT: unlinked refunds ENABLED — refund ${unlinked.json.refund?.id} status ` +
        `${unlinked.json.refund?.status}; $1.00 headed to the owner's card.`
    : `VERDICT: see error above — a FORBIDDEN/unauthorized code means entitlement is NOT ` +
        `enabled; another validation error means the request shape still needs adjusting.`,
);
