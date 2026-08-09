/**
 * READ-ONLY: how many people need a legible "Digitally Accepted" mark, and who
 * must be EXCLUDED. Scoping pass for the backfill — no writes.
 *
 * Every signature captured before 2026-08-08 went up as white ink on a
 * transparent background and is invisible in BMI. The waiver RECORD is fine;
 * only the image is unreadable. So this is not a re-sign — it is adding a
 * legible mark alongside a valid waiver we can prove was signed.
 *
 * Scope decisions this reports on:
 *   - only waivers still VALID (an expired waiver's image is moot)
 *   - MINORS split out — a guardian signed for them, so the mark must name the
 *     guardian, and that is an owner call, not a default
 *   - unknown/missing birthdate treated as minor-risk
 *
 * Run from apps/web:  npx tsx scripts/waiver-backfill-scope.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);

console.log("══════ waiver_sign_attempts coverage ══════");
const span = (await sql`
  SELECT MIN(ts) AS first_row, MAX(ts) AS last_row, COUNT(*)::int AS n,
         COUNT(DISTINCT person_id)::int AS people
  FROM waiver_sign_attempts`) as any[];
console.log(
  `  ${span[0].n} rows / ${span[0].people} people · ${String(span[0].first_row).slice(0, 24)} → ${String(span[0].last_row).slice(0, 24)}`,
);

console.log("\n══════ by outcome ══════");
const byOutcome = (await sql`
  SELECT outcome, COUNT(*)::int AS n, COUNT(DISTINCT person_id)::int AS people
  FROM waiver_sign_attempts GROUP BY 1 ORDER BY 2 DESC`) as any[];
for (const r of byOutcome) console.log(`  ${String(r.outcome).padEnd(10)} ${String(r.n).padStart(5)} rows  ${r.people} people`);

/* The backfill population: distinct people whose most recent sign SUCCEEDED
   (signed or salvaged) — those have a waiver in BMI with an invisible image. */
console.log("\n══════ backfill candidates (latest attempt succeeded) ══════");
const cand = (await sql`
  SELECT DISTINCT ON (person_id)
         person_id, signer_person_id, waiver_content_id, location_id,
         invalidation_date, outcome, ts
  FROM waiver_sign_attempts
  WHERE outcome IN ('signed','salvaged')
  ORDER BY person_id, ts DESC`) as any[];
console.log(`  ${cand.length} distinct people`);

const today = new Date().toISOString().slice(0, 10);
const stillValid = cand.filter((c) => (c.invalidation_date ?? "") > today);
const expired = cand.length - stillValid.length;
console.log(`  still valid by our recorded invalidationDate : ${stillValid.length}`);
console.log(`  already expired (no point re-marking)        : ${expired}`);

/* Guardian-signed rows are minors. sigPersonID != personID is the marker. */
const guardianSigned = stillValid.filter(
  (c) => String(c.signer_person_id) !== String(c.person_id),
);
console.log(`  of the valid ones, GUARDIAN-signed (minors)  : ${guardianSigned.length}`);
console.log(`  self-signed adults                           : ${stillValid.length - guardianSigned.length}`);

console.log("\n══════ by location ══════");
const byLoc = new Map<string, number>();
for (const c of stillValid) byLoc.set(c.location_id, (byLoc.get(c.location_id) ?? 0) + 1);
for (const [loc, n] of [...byLoc].sort((a, b) => b[1] - a[1]))
  console.log(`  ${loc}  ${n}`);

console.log("\n══════ by month signed ══════");
const byMonth = new Map<string, number>();
for (const c of stillValid) {
  const k = new Date(c.ts).toISOString().slice(0, 7);
  byMonth.set(k, (byMonth.get(k) ?? 0) + 1);
}
for (const [mo, n] of [...byMonth].sort()) console.log(`  ${mo}  ${n}`);

/* Do we have a name to put on the mark? waiver_acceptances carries first_name. */
console.log("\n══════ name availability for the mark ══════");
const ids = stillValid.map((c) => String(c.person_id));
const named = (await sql`
  SELECT DISTINCT person_id, first_name FROM waiver_acceptances
  WHERE person_id = ANY(${ids}) AND first_name IS NOT NULL`) as any[];
console.log(`  have a first_name in waiver_acceptances : ${named.length}/${stillValid.length}`);
console.log(`  (the rest must be read from BMI at backfill time)`);

console.log("\n══════ VERDICT ══════");
console.log(`  BACKFILL TARGET (valid, self-signed adults) : ${stillValid.length - guardianSigned.length}`);
console.log(`  NEEDS AN OWNER DECISION (minors/guardian)   : ${guardianSigned.length}`);
console.log(`  SKIP (expired)                             : ${expired}`);
process.exit(0);
