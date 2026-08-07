/**
 * READ-ONLY: of the 1,646 waiver_acceptances rows, how many actually landed a
 * BMI waiver record (waiver_id present) vs. were logged locally only? And are
 * those people's waivers live in Pandora right now? NO WRITES.
 *
 * Distinguishes two very different claims:
 *   (a) "the WAIVER never reached BMI"          → waiver_id NULL / Pandora has no expiry
 *   (b) "the PERSON never joined the RESERVATION" → kiosk_waiver_joins empty (separate)
 *
 * Run from apps/web:  npx tsx scripts/waiver-reached-bmi-check.mts [sampleSize]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const { sql } = await import("@/lib/db");
const q = sql();
const SAMPLE = Number(process.argv[2] || 40);
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const FT_RACING_LOC = "LAB52GY480CJF";

console.log("══════ waiver_acceptances: did the WAIVER reach BMI? ══════");
const agg = (await q`
  SELECT count(*)::int AS total,
         count(waiver_id)::int AS with_waiver_id,
         count(*) FILTER (WHERE waiver_id IS NULL)::int AS no_waiver_id,
         count(DISTINCT person_id)::int AS distinct_people,
         min(ts) AS oldest, max(ts) AS newest
  FROM waiver_acceptances
`) as Array<Record<string, any>>;
const a = agg[0];
console.log(`  total rows            : ${a.total}`);
console.log(`  distinct people       : ${a.distinct_people}`);
console.log(`  WITH bmi waiver_id    : ${a.with_waiver_id}   ← waiver DID reach BMI`);
console.log(`  WITHOUT waiver_id     : ${a.no_waiver_id}   ← logged locally only`);
console.log(`  range                 : ${String(a.oldest).slice(0, 10)} → ${String(a.newest).slice(0, 10)}`);

console.log("\n══════ by method / center ══════");
const byM = (await q`
  SELECT method, center, count(*)::int AS n,
         count(*) FILTER (WHERE waiver_id IS NULL)::int AS no_id
  FROM waiver_acceptances GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12
`) as Array<Record<string, any>>;
for (const r of byM)
  console.log(`  ${String(r.method ?? "-").padEnd(12)} ${String(r.center ?? "-").padEnd(12)} n=${String(r.n).padStart(5)} no_waiver_id=${r.no_id}`);

console.log(`\n══════ live Pandora check on a random sample of ${SAMPLE} people ══════`);
const sample = (await q`
  SELECT DISTINCT person_id, first_name FROM waiver_acceptances
  WHERE person_id IS NOT NULL ORDER BY person_id DESC LIMIT ${SAMPLE}
`) as Array<Record<string, any>>;
const key = process.env.SWAGGER_ADMIN_KEY || "";
let live = 0;
let expired = 0;
let none = 0;
let failed = 0;
for (const p of sample) {
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${FT_RACING_LOC}/${p.person_id}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) },
    );
    const data = (await res.json().catch(() => null)) as any;
    const exp = data?.data?.waiverExpiry ?? null;
    if (!exp) {
      none++;
      console.log(`  ✗ ${p.person_id} "${p.first_name}" — NO waiverExpiry in Pandora`);
    } else if (new Date(exp).getTime() > Date.now()) live++;
    else {
      expired++;
      console.log(`  · ${p.person_id} "${p.first_name}" — expired ${String(exp).slice(0, 10)}`);
    }
  } catch {
    failed++;
  }
}
console.log(`\n  live=${live}  expired=${expired}  NO-WAIVER-IN-BMI=${none}  lookupFailed=${failed}  (of ${sample.length})`);

console.log("\n══════ the SEPARATE question: reservation membership ══════");
const joins = (await q`SELECT count(*)::int AS n FROM kiosk_waiver_joins`) as Array<Record<string, any>>;
console.log(`  kiosk_waiver_joins rows: ${joins[0].n}`);
console.log("  (this is the table that records WHICH RESERVATION a signer belongs to;");
console.log("   waiver_acceptances has no project/bill column, so the link cannot be");
console.log("   reconstructed from it after the fact.)");
process.exit(0);
