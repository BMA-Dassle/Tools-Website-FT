/**
 * READ-ONLY: what the check-in browse list WOULD show, before vs after the fix.
 * Runs the real browseRowTime / browseRowIsOpen over today's live Neon rows.
 * NO WRITES.
 *
 * Two defects it measures:
 *   - the time was `eventAt || bookedAt`, and `event_at` is not a column on
 *     this table, so every racing row showed the BOOKING time
 *   - cancelled was judged per LEG off Neon's status, so a reservation
 *     cancelled in BMI stayed selectable
 *
 * Run from apps/web:  npx tsx scripts/browse-rows-dryrun.mts [YYYY-MM-DD]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const { browseRowTime, browseRowIsOpen } = await import("~/features/kiosk/checkin/browse-row");
const { sql } = await import("@/lib/db");
const q = sql();

const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const rows = (await q`
  SELECT bmi_bill_id AS bill, product_kind, status, booked_at, booking_metadata, booking_source
  FROM bowling_reservations
  WHERE bmi_bill_id IS NOT NULL
    AND booked_at > (${day}::date - interval '2 days')
  ORDER BY booked_at DESC
  LIMIT 400
`) as Array<Record<string, any>>;

const byBill = new Map<string, any[]>();
for (const r of rows) {
  const l = byBill.get(String(r.bill)) ?? [];
  l.push({
    productKind: r.product_kind,
    status: r.status,
    bookedAt: r.booked_at,
    bookingMetadata: r.booking_metadata,
  });
  byBill.set(String(r.bill), l);
}

const fmt = (iso: string) => {
  if (!iso) return "—";
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  if (!m) return String(iso).slice(0, 16);
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
};

let changed = 0;
let hidden = 0;
let racing = 0;
console.log("bill      kinds       OLD (booked)   NEW (heat)     status");
for (const [bill, legs] of byBill) {
  const isRace = legs.some((l) => l.productKind === "race");
  if (!isRace) continue;
  racing++;
  const oldIso = legs.map((l) => String(l.bookedAt ?? "")).filter(Boolean).sort()[0] ?? "";
  const next = browseRowTime(legs);
  const open = browseRowIsOpen(legs);
  if (!open) hidden++;
  const differs = fmt(oldIso) !== fmt(next.iso);
  if (differs) changed++;
  if (differs || !open) {
    console.log(
      `${bill.slice(-6)}    ${legs.map((l) => l.productKind).join("+").padEnd(11)} ` +
        `${fmt(oldIso).padEnd(14)} ${fmt(next.iso).padEnd(14)} ` +
        `${legs.map((l) => l.status).join(",")}${open ? "" : "   ← NOW HIDDEN"}`,
    );
  }
}
console.log(
  `\nracing reservations: ${racing}   time CORRECTED: ${changed}   now hidden (cancelled): ${hidden}`,
);
process.exit(0);
