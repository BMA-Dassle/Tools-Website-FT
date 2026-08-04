/**
 * READ-ONLY: inspect the 5 sales_log rows still deposit_credit_pending=TRUE
 * after the 2026-07-30 close-out, and their bmi_deposit_failures twins.
 *
 * Run from apps/web:  npx tsx scripts/parked-racepack-pending-leftovers.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
/* eslint-disable @typescript-eslint/no-explicit-any */
const sql = neon(process.env.DATABASE_URL!);

const rows = (await sql`
  SELECT ts, bill_id, deposit_person_id, deposit_kind_id, deposit_amount,
         deposit_id, email, phone, race_product_names, total_usd
  FROM sales_log
  WHERE deposit_credit_pending = TRUE
  ORDER BY ts`) as any[];
console.log(`sales_log rows still pending: ${rows.length}\n`);
for (const r of rows) {
  console.log(
    `${r.ts}  bill=${r.bill_id}  person=${r.deposit_person_id}  kind=${r.deposit_kind_id}  amount=${r.deposit_amount}  deposit_id=${r.deposit_id}  ${JSON.stringify(r.race_product_names)} $${r.total_usd}  ${r.email}`,
  );
  const fails = (await sql`
    SELECT id, source, person_id, amount, attempts, resolved_at, resolved_deposit_id, last_error
    FROM bmi_deposit_failures
    WHERE source_ref = ${r.bill_id}`) as any[];
  if (fails.length === 0) {
    console.log(`  no bmi_deposit_failures row for this bill_id`);
  }
  for (const f of fails) {
    console.log(
      `  failures #${f.id} src=${f.source} person=${f.person_id} amount=${f.amount} attempts=${f.attempts} resolved_at=${f.resolved_at} resolved_deposit=${f.resolved_deposit_id} last_error=${f.last_error}`,
    );
  }
}
