/**
 * READ-ONLY: how were persons 57080464/57080519 named at signing time?
 * Dumps kiosk_waiver_joins + unified-waiver signing rows for these ids and
 * the kiosk_checkin_people first/last columns for event 69. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/w56444-waiver-join-probe.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const { sql } = await import("@/lib/db");
const q = sql();
const IDS = ["57080464", "57080519"];

console.log("══════ kiosk_checkin_people (event 69) first/last as bound ══════");
const ppl = (await q`
  SELECT id, slot_key, display_name, first_name, last_name, waiver_valid,
         created_at, updated_at
  FROM kiosk_checkin_people WHERE event_id = 69 ORDER BY id
`) as Array<Record<string, any>>;
for (const p of ppl)
  console.log(
    `  #${p.id} slot=${p.slot_key} display="${p.display_name}" first="${p.first_name}" last="${p.last_name}" waiver=${p.waiver_valid} created=${p.created_at} updated=${p.updated_at}`,
  );

console.log("\n══════ kiosk_waiver_joins for these person ids ══════");
try {
  const joins = (await q`
    SELECT * FROM kiosk_waiver_joins WHERE person_id = ANY(${IDS}) ORDER BY id
  `) as Array<Record<string, any>>;
  for (const j of joins) console.log(`  ${JSON.stringify(j)}`);
  if (joins.length === 0) console.log("  (none)");
} catch (e) {
  console.log(`  query failed: ${e instanceof Error ? e.message : e}`);
}

console.log("\n══════ any other tables recording these ids (waiver signings) ══════");
const tables = (await q`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND column_name IN ('person_id','pandora_person_id','bmi_person_id')
  ORDER BY table_name
`) as Array<Record<string, any>>;
const seen = new Set<string>();
for (const t of tables) {
  const key = `${t.table_name}|${t.column_name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  try {
    const rows = (await q(
      `SELECT * FROM ${t.table_name} WHERE ${t.column_name}::text = ANY($1) LIMIT 10`,
      [IDS],
    )) as Array<Record<string, any>>;
    if (rows.length > 0) {
      console.log(`\n  ── ${t.table_name}.${t.column_name} (${rows.length}) ──`);
      for (const r of rows) {
        const s = JSON.stringify(r);
        console.log(`    ${s.length > 500 ? s.slice(0, 500) + "…" : s}`);
      }
    }
  } catch {
    /* skip tables that error (perm/shape) */
  }
}
process.exit(0);
