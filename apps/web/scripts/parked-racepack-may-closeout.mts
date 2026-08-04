/**
 * ONE-TIME WRITE (2026-07-30): clear the 4 Zapucioiu pre-queue pending
 * flags — verified whole via Office deposit history (credits landed 5/2,
 * balances remain). Same close-out class as the 9 queue rows cleared
 * earlier today. Does NOT touch Wendy Greisheimer's row (genuinely owed —
 * pending user decision).
 *
 * Run from apps/web:  npx tsx scripts/parked-racepack-may-closeout.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
/* eslint-disable @typescript-eslint/no-explicit-any */
const sql = neon(process.env.DATABASE_URL!);

const ZAPUCIOIU_BILLS = [
  "pack-1777702598544-ap00", // Marco — +3 landed 5/2 10:17a, balance 1
  "pack-1777702746605-j9wm", // Isabel — +3 landed 5/2 10:17a (+2 true-up), balance 1
  "pack-1777731978042-e2l8", // Ion — +3 landed 5/2 11:56a (+2 true-up), balance 1
  "pack-1777735100807-8j9w", // Luminita — +3 landed 5/2 11:57a (+3 again 1:05p), balance 2
];

const flipped = (await sql`
  UPDATE sales_log
  SET deposit_credit_pending = FALSE
  WHERE bill_id = ANY(${ZAPUCIOIU_BILLS}) AND deposit_credit_pending = TRUE
  RETURNING bill_id, deposit_person_id`) as any[];
console.log(`Zapucioiu flags flipped: ${flipped.length}`);
for (const r of flipped) console.log(`  ${r.bill_id} person=${r.deposit_person_id}`);

const pending = (await sql`
  SELECT ts, bill_id, deposit_person_id FROM sales_log WHERE deposit_credit_pending = TRUE`) as any[];
console.log(`\nverify: sales_log rows still deposit_credit_pending = ${pending.length}`);
for (const r of pending) console.log(`  ${r.ts} ${r.bill_id} person=${r.deposit_person_id}`);
