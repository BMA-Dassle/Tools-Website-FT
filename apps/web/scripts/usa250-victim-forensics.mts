/** READ-ONLY: USA250 victim forensics — who was actually over-charged?
 *
 *  Improves on usa250-bowling-overcharge-scan.mts, which listed "eligible"
 *  bookings but could not tell (a) who really applied the code, or (b) whether
 *  an order was already discounted (post-fix bookings look like candidates).
 *
 *  Three independent signals per reservation:
 *
 *  1. LINE CLASSIFICATION — fetch the day-of Square order and compare each
 *     catalog-linked line's unit price against bowling_square_products:
 *     ≈100% of catalog → CHARGED FULL; ≈75% → CHARGED DISCOUNTED (post-fix).
 *
 *  2. REDIS OVERVIEW (last ~24h only, booking-store TTL) — the checkout saved
 *     the DISPLAYED overview to `booking:bowl-{qamfReservationId}` /
 *     `booking:{billId}`. Lines carrying originalAmount/promoPct prove the
 *     guest saw "You saved $X" — and the stored totalTax shows the plugged tax
 *     (the incident signature: tax ≈ real tax + the absorbed discount).
 *
 *  3. WINDOW ELIGIBILITY — purchase/visit windows from the current code row.
 *
 *  Sweep is DELIBERATELY BROAD: all bowling_reservations inserted since the
 *  purchase window opened, ANY status (cancelled included), ANY visit date.
 *
 *  Usage: cd apps/web && npx tsx scripts/usa250-victim-forensics.mts
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
const { default: redis } = await import("@/lib/redis");
const q = sql();

// ── Code row ─────────────────────────────────────────────────────────
const codes = (await q`
  SELECT id, code, amount_pct, starts_at, expires_at, booking_date_start, booking_date_end
  FROM discount_codes WHERE UPPER(code) = 'USA250'
`) as Array<Record<string, unknown>>;
const code = codes[0];
const pct = Number(code.amount_pct);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
console.log(
  `USA250 ${pct}% | purchase ${iso(code.starts_at).slice(0, 10)}→${iso(code.expires_at).slice(0, 10)} | visit ${iso(code.booking_date_start).slice(0, 10)}→${iso(code.booking_date_end).slice(0, 10)}\n`,
);

// ── Catalog full prices (both centers) keyed by square catalog id ────
const products = (await q`
  SELECT square_catalog_object_id, price_cents FROM bowling_square_products WHERE price_cents > 0
`) as Array<{ square_catalog_object_id: string; price_cents: number }>;
const catalogPrice = new Map(products.map((p) => [p.square_catalog_object_id, p.price_cents]));

// ── Broad sweep: everything inserted since the purchase window opened ─
const rows = (await q`
  SELECT id, center_code, product_kind, status, guest_name, guest_email,
         booked_at, inserted_at, deposit_cents, total_cents,
         qamf_reservation_id, bmi_bill_id, square_dayof_order_id,
         square_deposit_payment_id, promo_code, promo_savings_cents
  FROM bowling_reservations
  WHERE inserted_at >= ${iso(code.starts_at)}::timestamptz
  ORDER BY inserted_at
`) as Array<Record<string, unknown>>;
console.log(`sweeping ${rows.length} reservations inserted since the purchase window opened…\n`);

type Verdict = {
  id: number;
  who: string;
  status: string;
  visit: string;
  paid: number;
  lineClass: string;
  redis: string;
  displayedSavings: number | null;
  refundCents: number;
};
const findings: Verdict[] = [];

for (const r of rows) {
  const oid = r.square_dayof_order_id ? String(r.square_dayof_order_id) : null;
  let lineClass = "no-order";
  let fullValueCents = 0; // catalog value of priced lines (excl. fee)
  let chargedValueCents = 0;
  if (oid) {
    const res = await fetch(`${SQUARE_BASE}/orders/${oid}`, { headers: SQ_H });
    const order = (await res.json()).order;
    if (!order) {
      lineClass = "order-fetch-failed";
    } else {
      let full = 0,
        disc = 0,
        unknown = 0;
      for (const li of order.line_items ?? []) {
        const unit = Number(li.base_price_money?.amount ?? 0);
        const qty = Number(li.quantity ?? 1);
        if (unit <= 0 || /booking fee/i.test(String(li.name ?? ""))) continue;
        const cat = li.catalog_object_id ? catalogPrice.get(String(li.catalog_object_id)) : null;
        chargedValueCents += unit * qty;
        if (cat == null) {
          unknown++;
          fullValueCents += unit * qty; // no reference — assume charged=full
          continue;
        }
        fullValueCents += cat * qty;
        if (Math.abs(unit - cat) <= 1) full++;
        else if (Math.abs(unit - Math.round(cat * (1 - pct / 100))) <= 1) disc++;
        else unknown++;
      }
      lineClass =
        disc > 0 && full === 0
          ? "DISCOUNTED (post-fix, charged correctly)"
          : full > 0 && disc === 0
            ? "FULL PRICE"
            : full === 0 && disc === 0
              ? "no priced catalog lines"
              : `MIXED (full=${full} disc=${disc} unknown=${unknown})`;
    }
  }

  // Redis displayed-overview probe (last ~24h only)
  let redisSig = "expired/none";
  let displayedSavings: number | null = null;
  const keys = [
    r.qamf_reservation_id ? `booking:bowl-${r.qamf_reservation_id}` : null,
    r.bmi_bill_id ? `booking:${r.bmi_bill_id}` : null,
  ].filter(Boolean) as string[];
  for (const k of keys) {
    try {
      const raw = await redis.get(k);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      const ov = JSON.parse(rec.overviews ?? "[]")[0];
      const lines: Array<{ amount: number; originalAmount?: number; quantity: number }> =
        ov?.lines ?? [];
      const saved = lines.reduce(
        (s, l) => s + (l.originalAmount != null ? l.originalAmount - l.amount : 0),
        0,
      );
      if (saved > 0) {
        displayedSavings = Math.round(saved * 100);
        const shownTax = ov?.totalTax?.[0]?.amount ?? null;
        redisSig = `PROMO SHOWN (displayed saved ${d(displayedSavings)}, tax line ${shownTax != null ? `$${shownTax.toFixed(2)}` : "?"})`;
      } else {
        redisSig = "stored, no promo stamps";
      }
      break;
    } catch {
      /* key missing / parse issue — keep looking */
    }
  }

  // Refund owed only when we KNOW they were charged full price:
  // pre-tax overcharge = pct% of the catalog value, +6.5%/6% county tax.
  const rate = String(r.center_code).includes("PPTR") ? 0.06 : 0.065;
  const promoShown = displayedSavings != null;
  const chargedFull = lineClass === "FULL PRICE" && chargedValueCents >= fullValueCents;
  const refundCents =
    chargedFull && Number(r.deposit_cents) > 0
      ? Math.round(Math.round(fullValueCents * (pct / 100)) * (1 + rate))
      : 0;

  // Report anything interesting: promo shown, full-price in the visit window,
  // discounted (for completeness), or already stamped by the new columns.
  const visitYmd = iso(r.booked_at).slice(0, 10);
  const inVisitWindow =
    visitYmd >= iso(code.booking_date_start).slice(0, 10) &&
    visitYmd <= iso(code.booking_date_end).slice(0, 10);
  const interesting =
    promoShown || r.promo_code != null || (inVisitWindow && lineClass !== "no-order");
  if (!interesting) continue;

  findings.push({
    id: Number(r.id),
    who: `${r.guest_name} <${r.guest_email ?? "—"}>`,
    status: String(r.status),
    visit: iso(r.booked_at).slice(0, 16),
    paid: Number(r.deposit_cents),
    lineClass,
    redis: redisSig,
    displayedSavings,
    refundCents,
  });
  console.log(
    `#${r.id} ${String(r.status).toUpperCase()} ${r.product_kind} | ${r.guest_name} | visit ${visitYmd} | paid ${d(Number(r.deposit_cents))}` +
      `\n    lines: ${lineClass}${r.promo_code ? ` | stamped ${r.promo_code} −${d(Number(r.promo_savings_cents))}` : ""}` +
      `\n    redis: ${redisSig}` +
      (refundCents > 0 ? `\n    → refund if code confirmed: ${d(refundCents)}` : "") +
      `\n    payment ${String(r.square_deposit_payment_id ?? "—")}`,
  );
}

const confirmed = findings.filter((f) => f.displayedSavings != null && f.refundCents > 0);
const fullInWindow = findings.filter((f) => f.refundCents > 0);
console.log(
  `\nSUMMARY: ${findings.length} flagged | ${confirmed.length} CONFIRMED victims (promo shown + charged full)` +
    ` | ${fullInWindow.length} charged-full-in-window (refund exposure ${d(fullInWindow.reduce((s, f) => s + f.refundCents, 0))})`,
);
console.log(
  "Redis proof only survives ~24h (booking-store TTL). Older bookings: cancelled/full-price rows above\n" +
    "+ guest reports are the source of truth; Clarity replays (~30d) can confirm individual sessions.",
);
process.exit(0);
