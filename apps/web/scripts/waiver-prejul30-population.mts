/**
 * READ-ONLY: waiver_sign_attempts only starts 2026-07-30 (when the table was
 * created). Signatures BEFORE that are equally invisible but invisible to this
 * log too. How many people are in that older tail, and can we reconstruct
 * enough to mark them (person id + waiver id + centre)?
 *
 * Run from apps/web:  npx tsx scripts/waiver-prejul30-population.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);

const span = (await sql`
  SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*)::int AS n,
         COUNT(DISTINCT person_id)::int AS people
  FROM waiver_acceptances`) as any[];
console.log(`waiver_acceptances : ${span[0].n} rows / ${span[0].people} people`);
console.log(`  ${String(span[0].first).slice(0, 24)} → ${String(span[0].last).slice(0, 24)}`);

console.log(`\nby method (the pad path is "signature"):`);
const byM = (await sql`
  SELECT method, COUNT(*)::int AS n, COUNT(DISTINCT person_id)::int AS people,
         MIN(ts) AS first, MAX(ts) AS last
  FROM waiver_acceptances GROUP BY 1 ORDER BY 2 DESC`) as any[];
for (const r of byM)
  console.log(
    `  ${String(r.method).padEnd(10)} ${String(r.n).padStart(5)} rows  ${String(r.people).padStart(5)} people  ${String(r.first).slice(4, 15)} → ${String(r.last).slice(4, 15)}`,
  );

/* The tail: pad signatures logged BEFORE waiver_sign_attempts existed. */
console.log(`\npre-2026-07-30 "signature" rows not covered by waiver_sign_attempts:`);
const tail = (await sql`
  SELECT COUNT(DISTINCT a.person_id)::int AS people, COUNT(*)::int AS rows,
         COUNT(a.waiver_id)::int AS with_waiver_id
  FROM waiver_acceptances a
  WHERE a.method = 'signature' AND a.ts < '2026-07-30'
    AND NOT EXISTS (
      SELECT 1 FROM waiver_sign_attempts s WHERE s.person_id = a.person_id
    )`) as any[];
console.log(
  `  ${tail[0].people} people / ${tail[0].rows} rows · ${tail[0].with_waiver_id} carry a waiver_id`,
);
console.log(`  (no signature bytes, no contentID, no invalidationDate recorded then —`);
console.log(`   marking these means re-deriving the template + expiry, not replaying)`);
process.exit(0);
