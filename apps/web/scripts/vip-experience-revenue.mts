/**
 * Ultimate VIP Experience (combo_special_id = 'race-bowl') revenue report.
 * READ-ONLY: Neon for the booking graph, Square for the actual dollars.
 *
 * Data-model traps this script gets right — each one silently inflates
 * revenue roughly 2x (2026-07-02 correction):
 *
 * 1. One booking = one square_deposit_order_id GROUP. Both legs (race + open)
 *    are bowling_reservations rows sharing the deposit order, but each leg has
 *    its OWN square_dayof_order_id (racing -> FastTrax FM, bowling -> HeadPinz
 *    FM). Grouping by square_dayof_order_id counts every booking twice.
 * 2. The race leg's player_count is race SEATS (the package includes 2 races
 *    per guest), not people. The open (bowling) leg's player_count is the
 *    actual guest count.
 * 3. The combo is FULL prepay: the booking-time "deposit" charge equals the
 *    tax-inclusive package total, which equals the sum of the two day-of
 *    orders (those are settled internally from the shared gift card later).
 *    Revenue = deposit-order tenders. Never add day-of order totals on top,
 *    and never assume a 50% deposit.
 * 4. The bowling leg's booked_at can drift days after the race (QAMF
 *    roll-forward); the race leg's booked_at is the event date. booked_at is
 *    stored UTC — convert to America/New_York before bucketing by day.
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const DB = process.env.DATABASE_URL;
if (!TOKEN || !DB) {
  console.error("SQUARE_ACCESS_TOKEN / DATABASE_URL missing in .env.local");
  process.exit(1);
}
const sql = neon(DB);

interface Group {
  dep: string | null;
  guests: number | null;
  race_seats: number | null;
  race_at: string | null;
  statuses: string[];
  booked_on: string;
}
const groups = (await sql`
  SELECT COALESCE(square_deposit_order_id, square_dayof_order_id) AS dep,
         max(player_count) FILTER (WHERE product_kind = 'open')  AS guests,
         max(player_count) FILTER (WHERE product_kind = 'race')  AS race_seats,
         min(booked_at::text) FILTER (WHERE product_kind = 'race') AS race_at,
         array_agg(DISTINCT status)                               AS statuses,
         min(inserted_at::text)                                   AS booked_on
  FROM bowling_reservations
  WHERE combo_special_id = 'race-bowl'
  GROUP BY 1
  ORDER BY min(inserted_at)
`) as Group[];

function etDate(pgTimestamp: string): string {
  const iso = pgTimestamp.replace(" ", "T").replace(/(\+00.*)?$/, "Z");
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

interface SquareOrder {
  tenders?: Array<{ amount_money?: { amount?: number } }>;
  refunds?: Array<{ amount_money?: { amount?: number } }>;
  return_amounts?: { total_money?: { amount?: number } };
}
async function depositMoney(orderId: string): Promise<{ paid: number; refunded: number } | null> {
  const res = await fetch(`https://connect.squareup.com/v2/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
  const data = (await res.json()) as { order?: SquareOrder; errors?: unknown };
  if (!data.order) {
    console.error(`order ${orderId}: ${JSON.stringify(data.errors ?? data)}`);
    return null;
  }
  const paid = (data.order.tenders ?? []).reduce((s, t) => s + (t.amount_money?.amount ?? 0), 0);
  const refunded = data.order.refunds?.length
    ? data.order.refunds.reduce((s, r) => s + (r.amount_money?.amount ?? 0), 0)
    : (data.order.return_amounts?.total_money?.amount ?? 0);
  return { paid, refunded };
}

interface Bucket {
  n: number;
  guests: number;
  paid: number;
  refunded: number;
}
const bucket = (): Bucket => ({ n: 0, guests: 0, paid: 0, refunded: 0 });
const past = bucket();
const upcoming = bucket();
const cancelled = bucket();
let skipped = 0;

console.log("event(ET)   guests  paid       refunded  status");
for (const g of groups) {
  if (!g.dep) {
    skipped += 1;
    console.log(`(no deposit order) statuses=${g.statuses.join(",")}`);
    continue;
  }
  const money = await depositMoney(g.dep);
  if (!money) {
    skipped += 1;
    continue;
  }
  const ev = etDate(g.race_at ?? g.booked_on);
  const isCancelled = g.statuses.every((s) => s === "cancelled");
  const b = isCancelled ? cancelled : ev <= TODAY ? past : upcoming;
  b.n += 1;
  b.guests += g.guests ?? 0;
  b.paid += money.paid;
  b.refunded += money.refunded;
  console.log(
    `${ev}   ${String(g.guests ?? "?").padStart(3)}   $${(money.paid / 100).toFixed(2).padStart(8)}  ` +
      `$${(money.refunded / 100).toFixed(2).padStart(7)}  ${g.statuses.join(",")}`,
  );
}

const fmt = (b: Bucket) =>
  `${String(b.n).padStart(3)} bookings  ${String(b.guests).padStart(4)} guests  ` +
  `paid $${(b.paid / 100).toFixed(2).padStart(9)}  refunded $${(b.refunded / 100).toFixed(2)}`;
console.log(`\n=== Ultimate VIP Experience — actual Square collections (tax-inclusive) ===`);
console.log(`Past events (ET <= ${TODAY}):  ${fmt(past)}`);
console.log(`Upcoming/booked:               ${fmt(upcoming)}`);
console.log(`Cancelled:                     ${fmt(cancelled)}`);
const live: Bucket = {
  n: past.n + upcoming.n,
  guests: past.guests + upcoming.guests,
  paid: past.paid + upcoming.paid,
  refunded: past.refunded + upcoming.refunded,
};
console.log(`TOTAL (non-cancelled):         ${fmt(live)}`);
const netAll = live.paid + cancelled.paid - live.refunded - cancelled.refunded;
console.log(`NET all-in (incl cancelled paid - refunded): $${(netAll / 100).toFixed(2)}`);
if (skipped) console.log(`groups skipped (missing/failed deposit order): ${skipped}`);
const first = groups[0];
if (first) {
  console.log(
    `\nFirst booking: made ${first.booked_on} UTC (${etDate(first.booked_on)} ET), ` +
      `event ${etDate(first.race_at ?? first.booked_on)}, ${first.guests ?? "?"} guests`,
  );
}
process.exit(0);
