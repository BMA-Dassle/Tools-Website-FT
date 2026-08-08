/**
 * READ-ONLY: the real loss class. Every row where WE recorded outcome='signed'
 * (Pandora returned 201 + a waiverID) but the person has NO waiverExpiry in BMI
 * — i.e. Pandora acknowledged a write that never registered.
 *
 * Provenance is settled (waiver-expiry-provenance.mts): people with ZERO
 * memberships still show a waiverExpiry, so waiverExpiry tracks the WAIVER, not
 * the membership. A missing expiry therefore means the signature did not land.
 *
 * Grouped by reservation via kiosk_waiver_joins.project_id, because the report
 * was "several GROUPS", not several people.
 *
 * Run from apps/web:  npx tsx scripts/waiver-signed-but-no-expiry-sweep.mts [days] [limit]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOCS: Array<[string, string]> = [
  ["fasttrax", "LAB52GY480CJF"],
  ["headpinz", "TXBSQN0FEKQ11"],
  ["naples", "PPTR5G2N0QXF7"],
];
const DAYS = Number(process.argv[2] || 30);
const LIMIT = Number(process.argv[3] || 400);

/** waiverExpiry at the location we FILED at, then any other location. */
async function expiryAnywhere(
  id: string,
  filedLoc: string,
): Promise<{ atFiled: string | null; elsewhere: string | null; unreadable: boolean }> {
  let unreadable = false;
  const order = [
    ...LOCS.filter(([, l]) => l === filedLoc),
    ...LOCS.filter(([, l]) => l !== filedLoc),
  ];
  let atFiled: string | null = null;
  let elsewhere: string | null = null;
  for (const [, loc] of order) {
    try {
      const r = await fetch(`${PANDORA}/bmi/person/${loc}/${id}?picture=false&allRelated=false`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) {
        if (r.status >= 500) unreadable = true;
        continue;
      }
      const d = (await r.json().catch(() => null)) as any;
      const e = d?.data?.waiverExpiry ?? null;
      if (loc === filedLoc) atFiled = e;
      else if (e && !elsewhere) elsewhere = e;
    } catch {
      unreadable = true;
    }
  }
  return { atFiled, elsewhere, unreadable };
}

const rows = (await sql`
  SELECT DISTINCT ON (a.person_id)
         a.person_id, a.ts, a.waiver_id, a.location_id, a.signature_bytes,
         a.signer_person_id, a.waiver_content_id
  FROM waiver_sign_attempts a
  WHERE a.outcome = 'signed' AND a.ts > NOW() - (${DAYS} || ' days')::interval
  ORDER BY a.person_id, a.ts DESC
  LIMIT ${LIMIT}`) as any[];

console.log(`══════ checking ${rows.length} 'signed' rows from the last ${DAYS}d ══════\n`);

const lost: any[] = [];
const misfiled: any[] = [];
let ok = 0;
let unread = 0;
let i = 0;
for (const r of rows) {
  i++;
  const id = String(r.person_id);
  const { atFiled, elsewhere, unreadable } = await expiryAnywhere(id, String(r.location_id));
  const valid = atFiled && new Date(atFiled).getTime() > Date.now();
  if (valid) {
    ok++;
  } else if (elsewhere) {
    misfiled.push({ ...r, elsewhere });
    console.log(`  ⚠ ${id} filed@${r.location_id} has NO expiry there, but DOES elsewhere (${String(elsewhere).slice(0, 10)})`);
  } else if (unreadable) {
    unread++;
  } else {
    lost.push(r);
    console.log(
      `  ✗ ${id} signed ${String(r.ts).slice(4, 21)} waiverID=${r.waiver_id} bytes=${r.signature_bytes} → NO WAIVER IN BMI`,
    );
  }
  if (i % 50 === 0) console.log(`     …${i}/${rows.length}`);
}

console.log(`\n══════ TOTALS ══════`);
console.log(`  checked                : ${rows.length}`);
console.log(`  waiver live in BMI     : ${ok}`);
console.log(`  ACKED BUT NOT IN BMI   : ${lost.length}   ← Pandora returned 201 + waiverID, nothing stored`);
console.log(`  filed at wrong location: ${misfiled.length}`);
console.log(`  unreadable (5xx/null-DOB): ${unread}`);

if (lost.length > 0) {
  const ids = lost.map((l) => String(l.person_id));
  const groups = (await sql`
    SELECT project_id, count(*)::int AS n,
           string_agg(DISTINCT display_name, ', ') AS who
    FROM kiosk_waiver_joins
    WHERE person_id = ANY(${ids})
    GROUP BY project_id ORDER BY n DESC`) as any[];
  console.log(`\n══════ AFFECTED GROUPS (via kiosk_waiver_joins) ══════`);
  if (groups.length === 0) console.log("  (none of the lost signers came through a booking /waiver link)");
  for (const g of groups) console.log(`  project ${g.project_id}  ${g.n} lost signer(s): ${g.who}`);
}
process.exit(0);
