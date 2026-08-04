/**
 * READ-ONLY: Pandora person records 57080464 / 57080519 ("Adult 1." / "Adult 2."
 * on W56444) — names, DOB, contact, waiver, creation info. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/w56444-adult-persons-probe.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const FASTTRAX = "LAB52GY480CJF";

for (const pid of ["57080464", "57080519"]) {
  console.log(`\n══════ person ${pid} ══════`);
  const res = await fetch(`${PANDORA_URL}/bmi/person/${FASTTRAX}/${pid}?picture=false&allRelated=false`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const data = (await res.json().catch(() => null)) as any;
  if (!res.ok || !data?.success) {
    console.log(`  fetch failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    continue;
  }
  const p = data.data ?? {};
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const s = JSON.stringify(v);
    console.log(`  ${k} = ${s.length > 300 ? s.slice(0, 300) + "…" : s}`);
  }
}
process.exit(0);
