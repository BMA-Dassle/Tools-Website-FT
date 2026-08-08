/**
 * READ-ONLY: are 17-digit BMI Office person ids resolvable in Pandora, and does
 * it depend on AGE (a sync lag) or on the id space itself? NO WRITES.
 *
 * Why: a racer whose reservation points at an unresolvable person can never be
 * scheduled (assignToSlot needs a SHORT Pandora id) and always reads "waiver
 * needed" (checkRacerWaiverValid can't find them). 378 of 1,646 waiver rows
 * carry a 17-digit id, ALL inside the last 30 days. But at least one older
 * 17-digit id (james rose, 63000000005663782) DID resolve — so age matters, or
 * something changed. This settles which.
 *
 * Run from apps/web:  npx tsx scripts/office-id-resolve-audit.mts [sample]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const SAMPLE = Number(process.argv[2] || 30);
const BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const LOCS: Array<[string, string]> = [
  ["FT", "LAB52GY480CJF"],
  ["HPFM", "TXBSQN0FEKQ11"],
  ["HPN", "PPTR5G2N0QXF7"],
];
const KEY = process.env.SWAGGER_ADMIN_KEY || "";

async function resolvesAnywhere(id: string): Promise<string | null> {
  for (const [label, loc] of LOCS) {
    try {
      const res = await fetch(`${BASE}/bmi/person/${loc}/${id}?picture=false&allRelated=false`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(8000),
      });
      const d = (await res.json().catch(() => null)) as any;
      if (d?.data) return label;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

const { sql } = await import("@/lib/db");
const q = sql();

// Spread the sample across the whole history so age is actually varied.
const rows = (await q`
  SELECT person_id, first_name, ts, length(person_id) AS len
  FROM waiver_acceptances
  WHERE person_id IS NOT NULL
  ORDER BY ts
`) as Array<Record<string, any>>;

const long = rows.filter((r) => Number(r.len) >= 15);
const short = rows.filter((r) => Number(r.len) < 15);
console.log(`waiver_acceptances: ${rows.length} rows — 17-digit ${long.length}, short ${short.length}`);
if (long.length > 0) {
  console.log(
    `17-digit range: ${String(long[0].ts).slice(0, 10)} → ${String(long[long.length - 1].ts).slice(0, 10)}`,
  );
}

function spread<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

console.log(`\n══════ 17-digit Office ids (${Math.min(SAMPLE, long.length)} spread over time) ══════`);
let okLong = 0;
for (const r of spread(long, SAMPLE)) {
  const where = await resolvesAnywhere(String(r.person_id));
  if (where) okLong++;
  console.log(
    `  ${String(r.ts).slice(0, 10)} ${String(r.person_id).padEnd(20)} "${String(r.first_name ?? "").padEnd(12)}" ${where ? `RESOLVES @${where}` : "NOT FOUND"}`,
  );
}

console.log(`\n══════ short ids (${Math.min(10, short.length)} spread over time) ══════`);
let okShort = 0;
for (const r of spread(short, 10)) {
  const where = await resolvesAnywhere(String(r.person_id));
  if (where) okShort++;
  console.log(
    `  ${String(r.ts).slice(0, 10)} ${String(r.person_id).padEnd(20)} "${String(r.first_name ?? "").padEnd(12)}" ${where ? `RESOLVES @${where}` : "NOT FOUND"}`,
  );
}

// The counterexample: an OLD 17-digit id that was seen to resolve earlier.
console.log(`\n══════ control: james rose (old 17-digit, resolved earlier tonight) ══════`);
const ctl = await resolvesAnywhere("63000000005663782");
console.log(`  63000000005663782 ${ctl ? `RESOLVES @${ctl}` : "NOT FOUND"}`);

console.log(
  `\nVERDICT: 17-digit resolved ${okLong}/${Math.min(SAMPLE, long.length)}   short resolved ${okShort}/${Math.min(10, short.length)}`,
);
process.exit(0);
