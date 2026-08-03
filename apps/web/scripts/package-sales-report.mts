/**
 * READ-ONLY data pull for the Package Sales Report
 * (docs/reports/package-sales/ — Ultimate Qualifier, Rookie Pack,
 * Ultimate VIP Experience, by purchase source, lifetime).
 *
 * Run from apps/web:  npx tsx scripts/package-sales-report.mts
 *
 * Sources & method (2026-08-02 investigation):
 *  - WEB Ultimate Qualifier / Rookie Pack → `sales_log` rows with a
 *    `package_id` (written at every web confirmation since the packages
 *    launched 2026-04-28). Kiosk confirmations also write sales_log but
 *    WITHOUT package_id (kiosk-post-reserve doesn't forward it), so these
 *    rows are web-only by construction.
 *  - KIOSK Ultimate Qualifier → `bowling_reservations` race anchors:
 *    UQ books its Intermediate races on PACKAGE-ONLY BMI SKUs, which land in
 *    booking_metadata.heats[].productId along with booking_source. The SKU
 *    list is derived live from lib/packages.ts so new variants keep working.
 *  - KIOSK Rookie Pack → NOT TRACKABLE. Rookie shares race SKUs with plain
 *    Starter races and the kiosk persists no package identity. Its numbers
 *    are therefore web-only (understated).
 *  - Ultimate VIP Experience (race-bowl + race-bowl-v2 combined) →
 *    `bowling_reservations` combo legs. Dollars here are ACTUAL charged
 *    order totals (tax-inclusive, post-discount); one booking = one deposit
 *    order group (comps have no deposit order → solo row fallback).
 *  - UQ / Rookie dollars are COMPUTED: registry per-racer package price ×
 *    racers (pre-tax, promos/cancellations not netted out) — bill totals
 *    were never recorded per package (sales_log.total_usd is always NULL).
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const { _allPackages, packagePerRacerPrice } = await import("@/lib/packages");
const q = sql();

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

// Per-variant package prices + UQ package-only Intermediate SKU map,
// both straight from the registry so this script survives price changes
// and new variants.
const priceByPkg = new Map<string, number>();
const uqSkuToPkg = new Map<string, string>();
for (const p of _allPackages()) {
  priceByPkg.set(p.id, packagePerRacerPrice(p));
  if (!p.id.startsWith("ultimate-qualifier")) continue;
  for (const race of p.races) {
    if (race.tier !== "intermediate") continue;
    for (const t of race.tracks) uqSkuToPkg.set(String(t.productId), p.id);
  }
}
const uqSkus = [...uqSkuToPkg.keys()];

// ── 1. Web UQ + Rookie (sales_log, package_id families) ────────────────────
console.log("══ Web package sales (sales_log, per variant) ══");
const web = (await q`
  SELECT package_id, COUNT(*)::int AS bookings,
         COALESCE(SUM(participant_count), 0)::int AS racers,
         MIN(ts)::date AS first, MAX(ts)::date AS last
  FROM sales_log
  WHERE package_id ILIKE 'ultimate-qualifier%' OR package_id ILIKE 'rookie-pack%'
  GROUP BY 1 ORDER BY 1
`) as Array<{ package_id: string; bookings: number; racers: number; first: string; last: string }>;
let webUq = { bookings: 0, racers: 0, revenue: 0 };
let webRk = { bookings: 0, racers: 0, revenue: 0 };
for (const r of web) {
  const price = priceByPkg.get(r.package_id) ?? 0;
  const revenue = price * r.racers;
  const agg = r.package_id.startsWith("ultimate-qualifier") ? webUq : webRk;
  agg.bookings += r.bookings;
  agg.racers += r.racers;
  agg.revenue += revenue;
  console.log(
    `  ${r.package_id}  bookings=${r.bookings}  racers=${r.racers}  @$${price.toFixed(2)}  =${usd(revenue)}  (${String(r.first).slice(0, 10)} → ${String(r.last).slice(0, 10)})`,
  );
}

// ── 2. Kiosk UQ (race anchors, package-only Intermediate SKUs) ─────────────
console.log("\n══ Kiosk Ultimate Qualifier (race rows, package-only SKUs) ══");
const kioskHeats = (await q`
  SELECT h->>'productId' AS pid,
         COUNT(*)::int AS racer_heats,
         COUNT(DISTINCT r.id)::int AS bookings,
         MIN(r.inserted_at)::date AS first, MAX(r.inserted_at)::date AS last
  FROM bowling_reservations r,
       jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
  WHERE r.product_kind = 'race' AND r.booking_source = 'kiosk'
    AND h->>'productId' = ANY(${uqSkus})
  GROUP BY 1 ORDER BY 1
`) as Array<{ pid: string; racer_heats: number; bookings: number; first: string; last: string }>;
// One Intermediate heat per racer per booking → racer_heats ≈ racers.
const kioskByPkg = new Map<string, { racers: number }>();
for (const r of kioskHeats) {
  const pkg = uqSkuToPkg.get(r.pid)!;
  const agg = kioskByPkg.get(pkg) ?? { racers: 0 };
  agg.racers += r.racer_heats;
  kioskByPkg.set(pkg, agg);
}
const kioskUqBookings = (await q`
  SELECT COUNT(*)::int AS bookings, MIN(inserted_at)::date AS first
  FROM bowling_reservations r
  WHERE r.product_kind = 'race' AND r.booking_source = 'kiosk'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.booking_metadata::jsonb->'heats') h
      WHERE h->>'productId' = ANY(${uqSkus})
    )
`) as Array<{ bookings: number; first: string }>;
let kioskUq = { bookings: kioskUqBookings[0]?.bookings ?? 0, racers: 0, revenue: 0 };
for (const [pkg, agg] of kioskByPkg) {
  const price = priceByPkg.get(pkg) ?? 0;
  kioskUq.racers += agg.racers;
  kioskUq.revenue += price * agg.racers;
  console.log(`  ${pkg}  racers=${agg.racers}  @$${price.toFixed(2)}  =${usd(price * agg.racers)}`);
}
console.log(
  `  kiosk UQ bookings=${kioskUq.bookings}  racers=${kioskUq.racers}  since=${String(kioskUqBookings[0]?.first).slice(0, 10)}`,
);

// ── 3. Ultimate VIP Experience (combo legs, ACTUAL dollars) ─────────────────
console.log("\n══ Ultimate VIP Experience (race-bowl* combos, actual charged) ══");
const vip = (await q`
  WITH legs AS (
    SELECT combo_special_id, COALESCE(booking_source, 'web') AS src, status,
           total_cents, product_kind, player_count, inserted_at,
           COALESCE(square_deposit_order_id, 'row-' || id::text) AS grp
    FROM bowling_reservations
    WHERE combo_special_id IS NOT NULL
  ), grouped AS (
    SELECT grp, MAX(src) AS src,
           BOOL_OR(status IN ('cancelled', 'canceled', 'refunded')) AS canceled,
           SUM(total_cents)::bigint AS booking_cents,
           MAX(CASE WHEN product_kind = 'open' THEN player_count END) AS players,
           MIN(inserted_at) AS first_at
    FROM legs GROUP BY 1
  )
  SELECT src, canceled, COUNT(*)::int AS bookings,
         COALESCE(SUM(players), 0)::int AS guests,
         ROUND(SUM(booking_cents) / 100.0, 2)::float AS dollars,
         MIN(first_at)::date AS first
  FROM grouped GROUP BY 1, 2 ORDER BY 1, 2
`) as Array<{ src: string; canceled: boolean; bookings: number; guests: number; dollars: number; first: string }>;
let vipAll = { bookings: 0, guests: 0, gross: 0, net: 0, canceledBookings: 0 };
for (const r of vip) {
  vipAll.bookings += r.bookings;
  vipAll.guests += r.guests;
  vipAll.gross += r.dollars;
  if (r.canceled) vipAll.canceledBookings += r.bookings;
  else vipAll.net += r.dollars;
  console.log(
    `  src=${r.src}  canceled=${r.canceled}  bookings=${r.bookings}  guests=${r.guests}  ${usd(r.dollars)}  since=${String(r.first).slice(0, 10)}`,
  );
}

// ── 4. Report summary ───────────────────────────────────────────────────────
console.log("\n══════════ REPORT SUMMARY (web + kiosk combined) ══════════");
const uq = {
  bookings: webUq.bookings + kioskUq.bookings,
  racers: webUq.racers + kioskUq.racers,
  revenue: webUq.revenue + kioskUq.revenue,
};
console.log(
  `Ultimate Qualifier   bookings=${uq.bookings}  racers=${uq.racers}  revenue=${usd(uq.revenue)}  (web ${usd(webUq.revenue)} + kiosk ${usd(kioskUq.revenue)})`,
);
console.log(
  `Rookie Pack          bookings=${webRk.bookings}+  racers=${webRk.racers}+  revenue=${usd(webRk.revenue)}+  (web only — kiosk not trackable)`,
);
console.log(
  `Ultimate VIP Exp.    bookings=${vipAll.bookings}  guests=${vipAll.guests}  gross=${usd(vipAll.gross)}  net=${usd(vipAll.net)}  (${vipAll.canceledBookings} canceled)`,
);
console.log(
  `TOTAL                bookings=${uq.bookings + webRk.bookings + vipAll.bookings}  people=${uq.racers + webRk.racers + vipAll.guests}  revenue=${usd(uq.revenue + webRk.revenue + vipAll.gross)}`,
);
console.log(
  "\nCombo (Game Zone + Gel Blasters, Groupon replacement) launches Aug 2026 — " +
    "add its query here once the sell rail stamps a product identity in Neon.",
);
