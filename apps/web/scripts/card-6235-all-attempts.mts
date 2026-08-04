/**
 * READ-ONLY: every booking attempt Natalie Torres (941-467-4710) made today,
 * from the clickwrap ledger — proves how many times she actually retried.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-all-attempts.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
/* eslint-disable @typescript-eslint/no-explicit-any */
const sql = neon(process.env.DATABASE_URL!);
const et = (s: unknown) =>
  new Date(String(s)).toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false }).replace(",", "");

console.log("══════ clickwrap_acceptances — phone 9414674710 OR email like natalietorres1732 ══════");
const cw = (await sql`
  SELECT * FROM clickwrap_acceptances
  WHERE phone LIKE '%9414674710%' OR email ILIKE '%natalietorres1732%'
  ORDER BY ts`) as any[];
for (const r of cw)
  console.log(
    `  ${et(r.ts)} ET  bill=${r.bill_id ?? "-"}  $${((r.amount_cents ?? 0) / 100).toFixed(2)}  ` +
      `type=${r.booking_type}  name="${r.first_name}"  email="${r.email}"  ip=${r.ip_address}`,
  );

console.log("\n══════ every reserve_attempt for those bills ══════");
const bills = [...new Set(cw.map((r) => r.bill_id).filter(Boolean))];
if (bills.length) {
  const ra = (await sql.query(
    `SELECT id, created_at, state, failed_step, charge_cents, bill_id, base_key,
            deposit_payment_id, bmi_reservation_number, left(error, 240) AS err
     FROM reserve_attempts WHERE bill_id = ANY($1) ORDER BY created_at`,
    [bills],
  )) as any[];
  for (const a of ra)
    console.log(
      `  #${a.id} ${et(a.created_at)} ET  ${a.state}/${a.failed_step ?? "-"}  $${(a.charge_cents / 100).toFixed(2)}  ` +
        `bill=${a.bill_id} pay=${a.deposit_payment_id ?? "-"} bmi=${a.bmi_reservation_number ?? "-"}\n      ${(a.err ?? "").split("\n")[0]}`,
    );
}

console.log("\n══════ any bowling_reservations for this guest today ══════");
const br = (await sql`
  SELECT * FROM bowling_reservations
  WHERE created_at::date = '2026-07-28'
    AND (guest_name ILIKE '%torres%' OR guest_phone LIKE '%4674710%' OR guest_email ILIKE '%natalietorres%')
  ORDER BY created_at`.catch(() => [])) as any[];
console.log(`  ${br.length} row(s)`);
for (const r of br) console.log("  " + JSON.stringify(r));

process.exit(0);
