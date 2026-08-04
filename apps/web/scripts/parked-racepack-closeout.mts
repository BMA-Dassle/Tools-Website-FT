/**
 * ONE-TIME WRITE: close the 9 verified parked race-pack rows in
 * bmi_deposit_failures (all guests confirmed made whole 2026-07-30 via
 * Office deposit history — 8 same-day desk loads, 1 full refund) and
 * flip the matching sales_log.deposit_credit_pending flags so admin
 * Retry/Backfill can never double-credit them.
 *
 * Run from apps/web:  npx tsx scripts/parked-racepack-closeout.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
/* eslint-disable @typescript-eslint/no-explicit-any */
const sql = neon(process.env.DATABASE_URL!);

const ROW_IDS = [3, 9, 12, 14, 15, 20, 24, 25, 31];
const BILL_IDS = [
  "pack-1779644421747-en3m",
  "pack-1781459265697-3zs6",
  "pack-1782065004030-9cvd",
  "pack-1782830347864-2anv",
  "pack-1782939136790-bv2f",
  "pack-1783446403395-j2sv",
  "pack-1783627380214-cdtv",
  "pack-1783792512326-inmp",
  "pack-1784158327382-3qh4",
];

const closed = (await sql`
  UPDATE bmi_deposit_failures
  SET resolved_at = NOW(),
      notes = COALESCE(notes,'') || ' | Closed 2026-07-30: verified via Office deposit history — guest already credited by desk same day (row 14: refunded in full 7/13). No credits owed.'
  WHERE id = ANY(${ROW_IDS}) AND resolved_at IS NULL
  RETURNING id, source_ref, person_id, amount, attempts`) as any[];
console.log(`bmi_deposit_failures closed: ${closed.length}`);
for (const r of closed) {
  console.log(
    `  #${r.id} ref=${r.source_ref} person=${r.person_id} amount=${r.amount} attempts=${r.attempts}`,
  );
}

const flipped = (await sql`
  UPDATE sales_log
  SET deposit_credit_pending = FALSE
  WHERE bill_id = ANY(${BILL_IDS}) AND deposit_credit_pending = TRUE
  RETURNING bill_id, deposit_person_id, deposit_amount`) as any[];
console.log(`sales_log flags flipped: ${flipped.length}`);
for (const r of flipped) {
  console.log(`  ${r.bill_id} person=${r.deposit_person_id} amount=${r.deposit_amount}`);
}

const remaining = (await sql`
  SELECT COUNT(*)::int AS n FROM bmi_deposit_failures WHERE resolved_at IS NULL`) as any[];
console.log(`\nverify: unresolved rows left in bmi_deposit_failures = ${remaining[0].n}`);
const pending = (await sql`
  SELECT COUNT(*)::int AS n FROM sales_log WHERE deposit_credit_pending = TRUE`) as any[];
console.log(`verify: sales_log rows still deposit_credit_pending = ${pending[0].n}`);
