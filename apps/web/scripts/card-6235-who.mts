/**
 * READ-ONLY: find the ****6235 guest and their party. Scans every Neon table
 * for the bill id / QAMF id / GAN, then dumps the matching rows in full.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-who.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
/* eslint-disable @typescript-eslint/no-explicit-any */
const sql = neon(process.env.DATABASE_URL!);

const NEEDLES = ["63000000006501987", "X160982", "WEBHPFM06501987", "B8MYQJjNOGv4IZtl0f2UfSTRCqRZY"];

const cols = (await sql`
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND data_type IN ('text','character varying','jsonb','json','character')
  ORDER BY table_name`) as any[];

const byTable = new Map<string, string[]>();
for (const c of cols) {
  if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
  byTable.get(c.table_name)!.push(c.column_name);
}
console.log(`scanning ${byTable.size} tables for ${NEEDLES.join(" | ")}\n`);

for (const [table, columns] of byTable) {
  const where = columns.map((c) => `COALESCE("${c}"::text,'') ILIKE ANY($1)`).join(" OR ");
  const pats = NEEDLES.map((n) => `%${n}%`);
  let rows: any[];
  try {
    rows = (await sql.query(`SELECT * FROM "${table}" WHERE ${where} LIMIT 25`, [pats])) as any[];
  } catch (e) {
    continue;
  }
  if (!rows.length) continue;
  console.log(`\n══════ ${table} — ${rows.length} row(s) ══════`);
  for (const r of rows) {
    console.log("  " + JSON.stringify(r, null, 2).split("\n").join("\n  "));
  }
}
process.exit(0);
