/**
 * READ-ONLY: the full unlinked-refund destination matrix, for Square's rep.
 *
 * Pattern as of 2026-07-28: `unlinked: true` requests are accepted by the API,
 * but every destination that requires Square to actually DISBURSE money is
 * declined with the identical generic `REFUND_ERROR/REFUND_DECLINED — "Unlinked
 * refund could not be created"`:
 *
 *   EXTERNAL   → ACCEPTED, COMPLETED   (bookkeeping only, no Square disbursement)
 *   CARD       → declined ×3 (2 ccof records of one VISA CREDIT …5214)
 *   GIFT CARD  → declined (gftc: id; the GAN is not a valid destination shape)
 *
 * That shape points at the DISBURSEMENT being ungated (risk/underwriting or
 * balance), not at a card-network quirk — a gift card needs no card rail and
 * fails identically. The API cannot tell us which, so this dumps every artifact
 * with ids and timestamps to hand to the rep.
 *
 * Also verifies the probe gift card is clean (0¢, no REFUND activity) so it can
 * be left alone safely.
 *
 * Run from apps/web:  npx tsx scripts/unlinked-refund-matrix-report.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const PROBE_CARD = "gftc:27986f681a6d42289122e1d26fafb0b3";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}

console.log("═══ every unlinked refund on the account (since 2026-07-01) ═══");
// MUST paginate. A single page silently dropped the two 2026-07-27 attempts once
// the account's refund volume in the window exceeded one page, which understated
// the count we were about to quote to Square. Walk the cursor to the end.
const all: any[] = [];
let cursor = "";
let pages = 0;
do {
  const r = await sq(
    `/refunds?begin_time=${encodeURIComponent("2026-07-01T00:00:00Z")}` +
      `&sort_order=DESC&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  if (!r.ok) {
    console.log(`  page ${pages + 1} FAILED: ${JSON.stringify(r.json?.errors ?? r.status)}`);
    break;
  }
  all.push(...(r.json.refunds ?? []).filter((x: any) => x.unlinked === true || !x.payment_id));
  cursor = r.json.cursor ?? "";
  pages++;
} while (cursor && pages < 100);
console.log(`  (walked ${pages} page(s) of refund history)`);
console.log(`${all.length} unlinked refund object(s):\n`);
for (const x of all) {
  const card = x.destination_details?.card_details?.card;
  console.log(
    `  ${x.created_at?.slice(0, 19)}  ${String(x.amount_money?.amount).padStart(4)}¢  ` +
      `${String(x.status).padEnd(9)} dest=${String(x.destination_type ?? "?").padEnd(8)} ` +
      `loc=${x.location_id}` + (card ? `  ${card.card_brand} …${card.last_4} ${card.card_type}` : ""),
  );
  console.log(`      id=${x.id}`);
  console.log(`      reason="${x.reason ?? ""}"  order_id=${x.order_id ?? "none"}`);
}

console.log("\n═══ probe gift card state (must be clean to leave alone) ═══");
const gc = await sq(`/gift-cards/${PROBE_CARD}`);
console.log(
  gc.ok
    ? `  ${PROBE_CARD}\n  state=${gc.json.gift_card?.state} balance=${gc.json.gift_card?.balance_money?.amount}¢`
    : `  read failed: HTTP ${gc.status} ${JSON.stringify(gc.json?.errors)}`,
);
const acts = await sq(`/gift-cards/activities?gift_card_id=${PROBE_CARD}&limit=50`);
const kinds = (acts.json?.gift_card_activities ?? []).map((a: any) => a.type);
console.log(`  activities=[${kinds.join(", ")}]`);
console.log(
  kinds.includes("REFUND")
    ? "  ⚠ a REFUND activity EXISTS — value landed after all; do not treat the decline as final"
    : "  no REFUND activity — nothing landed, card is safe to leave at 0¢",
);
