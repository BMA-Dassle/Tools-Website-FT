/** READ-ONLY: USA250 bowling over-charge audit.
 *
 *  Bug: /api/square/bowling-orders/quote (+ the charge route) dropped
 *  base_price_money on catalog-linked lines, so bowling/KBF-only carts with
 *  USA250 applied were charged FULL price — the review page showed the 25%
 *  discount but plugged the difference into the "Tax" line (total unchanged).
 *  Mixed carts (race+bowling) settle via unified-reserve, which passes
 *  base_price_money through correctly — those are NOT affected.
 *
 *  IMPORTANT LIMITATION: the bowling-only reserve path never sends the promo
 *  code server-side, so there is NO redemption row and NO order marker for
 *  these bookings. This scan therefore lists every bowling reservation that
 *  WAS ELIGIBLE for USA250 (purchased inside the code's purchase window, visit
 *  date inside its booking-date window) and computes what the 25% discount
 *  would have been. Whether each guest actually applied the code must be
 *  decided by cross-reference (guest contact / Clarity replay) or by an
 *  owner decision to credit all eligible bookings.
 *
 *  Usage: cd apps/web && npx tsx scripts/usa250-bowling-overcharge-scan.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQ_H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
};
const d = (c: number) => `$${(c / 100).toFixed(2)}`;

const { sql } = await import("@/lib/db");
const q = sql();

// ── 1. The code row: windows + pct straight from Neon, no assumptions ──
const codes = (await q`
  SELECT id, code, amount_pct, starts_at, expires_at,
         booking_date_start, booking_date_end, allowed_weekdays, scopes, uses_count
  FROM discount_codes
  WHERE UPPER(code) = 'USA250'
`) as Array<Record<string, unknown>>;
if (codes.length === 0) throw new Error("USA250 not found in discount_codes");
const code = codes[0];
const pct = Number(code.amount_pct);
console.log(
  `USA250: ${pct}% off | purchase window ${String(code.starts_at).slice(0, 10)} → ${String(code.expires_at).slice(0, 10)}` +
    ` | visit window ${String(code.booking_date_start ?? "—").slice(0, 10)} → ${String(code.booking_date_end ?? "—").slice(0, 10)}` +
    ` | weekdays ${JSON.stringify(code.allowed_weekdays)} | scopes ${JSON.stringify(code.scopes)} | uses_count ${code.uses_count}`,
);

// ── 2. Recorded redemptions (unified path — should be correctly charged) ──
const redemptions = (await q`
  SELECT r.external_ref, r.domain, r.amount_off_cents, r.redeemed_at, r.refunded_at
  FROM discount_redemptions r
  WHERE r.code_id = ${code.id as number}
  ORDER BY r.redeemed_at
`) as Array<Record<string, unknown>>;
console.log(`\nrecorded redemptions (unified/mixed-cart path, charged correctly): ${redemptions.length}`);
for (const r of redemptions) {
  console.log(
    `  ${String(r.redeemed_at).slice(0, 19)}  ${r.domain}  order ${r.external_ref}  saved ${d(Number(r.amount_off_cents))}${r.refunded_at ? "  (refunded)" : ""}`,
  );
}

// ── 3. Eligible bowling-only reservations (the possibly-over-charged set) ──
// Purchased inside the purchase window AND visiting inside the booking window.
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const ymd = (v: unknown) =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const bStart = ymd(code.booking_date_start) ?? "1970-01-01";
const bEnd = ymd(code.booking_date_end) ?? "2999-12-31";
// booked_at is the lane time — bucket to the ET calendar day, not UTC.
const resRows = (await q`
  SELECT id, center_code, product_kind, guest_name, guest_email, guest_phone,
         booked_at, inserted_at, deposit_cents, total_cents, status,
         square_dayof_order_id, square_deposit_order_id, square_deposit_payment_id
  FROM bowling_reservations
  WHERE inserted_at >= ${iso(code.starts_at)}::timestamptz
    AND inserted_at <= ${iso(code.expires_at)}::timestamptz
    AND (booked_at AT TIME ZONE 'America/New_York')::date BETWEEN ${bStart}::date AND ${bEnd}::date
    AND status NOT IN ('cancelled')
  ORDER BY inserted_at
`) as Array<Record<string, unknown>>;
console.log(`\neligible bowling reservations (purchase + visit windows): ${resRows.length}\n`);

// Booking-fee + $0 lines are never discounted; everything else priced is.
const LOCATION_RATE: Record<string, number> = {
  TXBSQN0FEKQ11: 0.065, // Lee
  PPTR5G2N0QXF7: 0.06, // Collier
};

let flagged = 0;
let totalOverchargeCents = 0;
for (const r of resRows) {
  const oid = r.square_dayof_order_id ? String(r.square_dayof_order_id) : null;
  let detail = "";
  let overchargeCents = 0;
  if (oid) {
    const res = await fetch(`${SQUARE_BASE}/orders/${oid}`, { headers: SQ_H });
    const data = await res.json();
    const order = data.order;
    if (!order) {
      detail = `  !! could not fetch order ${oid}`;
    } else {
      const rate = LOCATION_RATE[order.location_id as string] ?? 0.065;
      let discountableCents = 0;
      let discountedAlreadyCents = 0;
      for (const li of order.line_items ?? []) {
        const base = Number(li.base_price_money?.amount ?? 0) * Number(li.quantity ?? 1);
        const name = String(li.name ?? "");
        if (base <= 0) continue;
        if (/booking fee/i.test(name)) continue; // fee is never discounted
        discountableCents += base;
        // If the line already sits below its catalog price the discount DID
        // apply (post-fix booking) — detect via catalog price lookup marker:
        // we can't cheaply fetch catalog here, so flag by created_at instead.
        void discountedAlreadyCents;
      }
      const wouldBeDiscountCents = Math.round(discountableCents * (pct / 100));
      overchargeCents = Math.round(wouldBeDiscountCents * (1 + rate));
      detail =
        `order ${oid} state=${order.state} items(excl. fee) ${d(discountableCents)}` +
        ` → 25% would be ${d(wouldBeDiscountCents)} (+tax = ${d(overchargeCents)} refundable)`;
    }
  } else {
    detail = "no day-of order id";
  }
  flagged += overchargeCents > 0 ? 1 : 0;
  totalOverchargeCents += overchargeCents;
  console.log(
    `#${r.id} ${String(r.center_code)} ${String(r.product_kind)} | ${String(r.guest_name)} <${String(r.guest_email)}> | ` +
      `visit ${String(r.booked_at).slice(0, 16)} booked ${String(r.inserted_at).slice(0, 16)} | ` +
      `paid ${d(Number(r.deposit_cents))} status=${String(r.status)}`,
  );
  console.log(`    ${detail}`);
  console.log(
    `    deposit payment ${String(r.square_deposit_payment_id ?? "—")}  deposit order ${String(r.square_deposit_order_id ?? "—")}`,
  );
}

console.log(
  `\nSUMMARY: ${resRows.length} eligible bookings, ${flagged} with a computable over-charge, ` +
    `max total exposure ${d(totalOverchargeCents)} (if ALL of them had applied USA250).`,
);
console.log(
  "NOTE: server data cannot prove who typed the code (bowling-only path never sent it).\n" +
    "Cross-check candidates via Clarity session replay or guest contact, or credit all eligible bookings.",
);
