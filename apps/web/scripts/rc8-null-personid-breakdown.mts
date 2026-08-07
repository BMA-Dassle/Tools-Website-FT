/**
 * READ-ONLY: of the race racers carrying NO bmiPersonId, how many are REAL
 * typed names (remediable — a person could be matched/created) vs placeholder
 * slot labels like "Adult 1" (not people at all)? Split past vs future, since
 * only upcoming reservations are operationally urgent. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/rc8-null-personid-breakdown.mts [days]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const { sql } = await import("@/lib/db");
const q = sql();
const DAYS = Number(process.argv[2] || 90);

const isPlaceholder = (s: string) => /^(adult|junior)\s*\d*$/i.test(s.trim());

const rows = (await q`
  SELECT r.id, r.bmi_bill_id, r.booked_at, r.status,
         h.e->>'racer'        AS racer,
         h.e->>'bmiPersonId'  AS person_id,
         h.e->>'heatId'       AS heat_id,
         h.e->>'category'     AS category
  FROM bowling_reservations r,
       LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(r.booking_metadata::jsonb->'heats')='array'
              THEN r.booking_metadata::jsonb->'heats' ELSE '[]'::jsonb END) AS h(e)
  WHERE r.product_kind = 'race' AND r.status = 'confirmed'
    AND r.booked_at > now() - (${DAYS} || ' days')::interval
`) as Array<Record<string, any>>;

let withId = 0;
const nullNamed: Array<Record<string, any>> = [];
const nullPlaceholder: Array<Record<string, any>> = [];
const nullBlank: Array<Record<string, any>> = [];
for (const r of rows) {
  if (r.person_id) {
    withId++;
    continue;
  }
  const name = (r.racer ?? "").trim();
  if (!name) nullBlank.push(r);
  else if (isPlaceholder(name)) nullPlaceholder.push(r);
  else nullNamed.push(r);
}

console.log(`══════ race racer rows, last ${DAYS}d (confirmed) ══════`);
console.log(`  total racer rows        : ${rows.length}`);
console.log(`  has bmiPersonId         : ${withId}`);
console.log(`  NULL id, REAL name      : ${nullNamed.length}   ← remediable people`);
console.log(`  NULL id, placeholder    : ${nullPlaceholder.length}   ← "Adult 1" slot labels, NOT people`);
console.log(`  NULL id, blank name     : ${nullBlank.length}`);

// Distinct humans (a racer appears once per heat)
const key = (r: any) => `${r.bmi_bill_id}|${(r.racer ?? "").trim().toLowerCase().split(/\s+/).join(" ")}`;
const distinctNamed = new Set(nullNamed.map(key));
console.log(`\n  distinct (bill, name) pairs with a real name and no id: ${distinctNamed.size}`);

// Future vs past — heatId is centre-local naive ET
const now = Date.now();
const future = nullNamed.filter((r) => {
  const t = r.heat_id ? Date.parse(String(r.heat_id) + "-04:00") : NaN;
  return Number.isFinite(t) && t > now;
});
const distinctFuture = new Set(future.map(key));
console.log(`  of those, still UPCOMING: ${distinctFuture.size}`);

console.log(`\n══════ sample of remediable rows (up to 25) ══════`);
const seen = new Set<string>();
let shown = 0;
for (const r of nullNamed) {
  const k = key(r);
  if (seen.has(k)) continue;
  seen.add(k);
  if (shown++ >= 25) break;
  console.log(
    `  bill=${r.bmi_bill_id} "${r.racer}" cat=${r.category ?? "?"} heat=${r.heat_id ?? "?"} booked=${String(r.booked_at).slice(0, 10)}`,
  );
}

console.log(`\n══════ how many reservations are affected ══════`);
const bills = new Set(nullNamed.map((r) => String(r.bmi_bill_id)));
console.log(`  ${bills.size} reservations contain at least one real-named racer with no BMI person`);
process.exit(0);
