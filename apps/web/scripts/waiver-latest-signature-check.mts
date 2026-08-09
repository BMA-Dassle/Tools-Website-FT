/**
 * READ-ONLY: the end-to-end check of the flatten fix.
 *
 * Pulls the most recent stored signature out of Neon and writes it to disk, so
 * the exported PNG can be LOOKED AT. Before the fix this would be a blank white
 * rectangle (white ink on transparent); after it, dark ink on an opaque page.
 *
 * Also asks BMI whether it stored anything (Office kind=5), which is expected
 * to remain 404 — Pandora accepts the image and discards it.
 *
 * Run from apps/web:  npx tsx scripts/waiver-latest-signature-check.mts [outDir] [n]
 */
import { readFileSync, writeFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const OUT = process.argv[2] || ".";
const N = Number(process.argv[3] || 3);

const rows = (await sql`
  SELECT id, ts, person_id, signer_person_id, location_id, invalidation_date,
         signature_bytes, rejected_reason, outcome, waiver_id, signature_png
  FROM waiver_signatures
  ORDER BY ts DESC LIMIT ${N}`) as any[];

if (rows.length === 0) {
  console.log("waiver_signatures is EMPTY — nothing captured yet.");
  process.exit(0);
}

for (const r of rows) {
  console.log(`\n════ waiver_signatures #${r.id} ════`);
  console.log(`  captured   : ${String(r.ts).slice(0, 24)}`);
  console.log(`  person     : ${r.person_id}   signer: ${r.signer_person_id}`);
  console.log(`  location   : ${r.location_id}   expiry: ${r.invalidation_date}`);
  console.log(`  bytes      : ${r.signature_bytes}${r.rejected_reason ? `  REJECTED: ${r.rejected_reason}` : ""}`);
  console.log(`  outcome    : ${r.outcome ?? "NULL (never settled)"}   waiverID: ${r.waiver_id ?? "-"}`);
  console.log(`  image held : ${r.signature_png ? "YES" : "NO"}`);
  if (r.signature_png) {
    const f = `${OUT}/neon-signature-${r.person_id}-${r.id}.png`;
    writeFileSync(f, Buffer.from(r.signature_png, "base64"));
    console.log(`  saved      : ${f}`);
  }

  // And what does BMI hold?
  try {
    const res = await fetch(
      `https://office-api22.sms-timing.com/api/${CLIENT_KEY}/image/picture?personId=${r.person_id}&kind=5`,
      { headers: { referer: "https://office.bmileisure.com/" }, signal: AbortSignal.timeout(15000) },
    );
    console.log(
      `  BMI kind=5 : ${res.ok ? `STORED ${(await res.arrayBuffer()).byteLength}B` : `NOT STORED (HTTP ${res.status})`}`,
    );
  } catch (e) {
    console.log(`  BMI kind=5 : ERR ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(0);
