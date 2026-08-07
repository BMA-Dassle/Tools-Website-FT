/**
 * READ-ONLY: prove the hardcoded-location defect. checkin/waiver.ts reads EVERY
 * racer's waiver at the FastTrax racing location only (LAB52GY480CJF), but Fort
 * Myers hosts TWO Pandora locations and Naples a third. A guest whose waiver
 * lives at HeadPinz FM reads back as "no waiver" at FastTrax. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/waiver-location-crosscheck.mts [n]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const { sql } = await import("@/lib/db");
const q = sql();
const N = Number(process.argv[2] || 12);
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const LOCS: Array<[string, string]> = [
  ["FastTrax racing", "LAB52GY480CJF"],
  ["HeadPinz FM", "TXBSQN0FEKQ11"],
  ["HeadPinz Naples", "PPTR5G2N0QXF7"],
];
const key = process.env.SWAGGER_ADMIN_KEY || "";

async function expiryAt(loc: string, personId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${PANDORA_BASE}/bmi/person/${loc}/${personId}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) },
    );
    const data = (await res.json().catch(() => null)) as any;
    return data?.data?.waiverExpiry ?? null;
  } catch {
    return null;
  }
}

// Most RECENT signature rows (ts DESC — not the lexicographic person_id sort
// that made the first pass sample only 7-digit ids).
const rows = (await q`
  SELECT person_id, first_name, center, ts, waiver_id
  FROM waiver_acceptances
  WHERE method = 'signature' AND person_id IS NOT NULL
  ORDER BY ts DESC LIMIT ${N}
`) as Array<Record<string, any>>;

console.log(`══════ ${rows.length} most-recent signatures, checked at ALL locations ══════`);
let ftOnly = 0;
let elsewhereOnly = 0;
let nowhere = 0;
for (const r of rows) {
  const found: string[] = [];
  for (const [label, loc] of LOCS) {
    const e = await expiryAt(loc, String(r.person_id));
    if (e) found.push(`${label}=${String(e).slice(0, 10)}`);
  }
  const atFt = found.some((f) => f.startsWith("FastTrax"));
  if (found.length === 0) nowhere++;
  else if (atFt) ftOnly++;
  else elsewhereOnly++;
  console.log(
    `  ${String(r.person_id).padEnd(12)} "${String(r.first_name ?? "").padEnd(12)}" center=${String(r.center ?? "-").padEnd(11)} waiver_id=${r.waiver_id ?? "NULL"}  → ${found.length ? found.join("  ") : "NOT FOUND AT ANY LOCATION"}`,
  );
}
console.log(
  `\n  readable at FastTrax: ${ftOnly}   only at another venue: ${elsewhereOnly}   nowhere: ${nowhere}`,
);
if (elsewhereOnly > 0) {
  console.log(
    `  → checkin/waiver.ts would call ${elsewhereOnly}/${rows.length} of these racers "waiver needed" even though their waiver is live.`,
  );
}
process.exit(0);
