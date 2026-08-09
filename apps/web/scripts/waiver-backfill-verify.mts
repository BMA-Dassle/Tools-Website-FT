/**
 * READ-ONLY: what the re-legible backfill just wrote — who, which waiverID, and
 * the exact PNG we stored, dumped to disk so the mark can be eyeballed without
 * opening BMI. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/waiver-backfill-verify.mts [outDir]
 */
import { readFileSync, writeFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const OUT = process.argv[2] || ".";
const TERMS = "relegible-2026-08-08";

const rows = (await sql`
  SELECT a.person_id, a.first_name, a.waiver_id, a.center, a.signed_by_person_id, a.ts
  FROM waiver_acceptances a
  WHERE a.terms_version = ${TERMS}
  ORDER BY a.ts`) as any[];

console.log(`══════ ${rows.length} people marked so far ══════`);
for (const r of rows) {
  const guardian = r.signed_by_person_id ? ` guardian=${r.signed_by_person_id}` : " (self-signed)";
  console.log(
    `  person=${String(r.person_id).padEnd(18)} "${r.first_name}"  waiverID=${r.waiver_id}  loc=${r.center}${guardian}`,
  );
}

// Pull the stored images back out — proof we now hold what we sent.
console.log(`\n══════ stored signature images (Neon waiver_signatures) ══════`);
const ids = rows.map((r) => String(r.person_id));
if (ids.length) {
  const sigs = (await sql`
    SELECT person_id, signature_bytes, outcome, waiver_id, signature_png
    FROM waiver_signatures
    WHERE person_id = ANY(${ids})
    ORDER BY ts DESC`) as any[];
  const seen = new Set<string>();
  for (const s of sigs) {
    const pid = String(s.person_id);
    console.log(
      `  ${pid.padEnd(18)} ${String(s.signature_bytes).padStart(7)}B outcome=${s.outcome} waiverID=${s.waiver_id ?? "-"} stored=${s.signature_png ? "YES" : "NO"}`,
    );
    if (s.signature_png && !seen.has(pid)) {
      seen.add(pid);
      writeFileSync(`${OUT}/backfill-mark-${pid}.png`, Buffer.from(s.signature_png, "base64"));
    }
  }
  console.log(`\n  wrote ${seen.size} PNG(s) to ${OUT}/backfill-mark-*.png`);
}
process.exit(0);
