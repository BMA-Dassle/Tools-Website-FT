/**
 * Run the ACTUAL statement the lead reads build, against the real database.
 *
 * This exists because `LEAD_SELECT` named two columns that do not exist
 * (`gfq.signed_at`, `gfq.sent_at` — the real ones are `contract_signed_at`
 * and `contract_sent_at`) and NOTHING caught it: tsc, eslint, 1,561 vitest
 * tests and a full `next build` all pass, because a column name inside a
 * template string is invisible to every one of them. It reached preview and
 * 500'd every lead read on the board.
 *
 * The check that would have caught it is this one — run the statement the code
 * BUILDS, not a hand-written query that looks like it. Those are different
 * artefacts, and only one of them ships.
 *
 *   npx tsx scripts/crm-check-lead-select.mts
 */
import fs from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { LEAD_SELECT, LEAD_FROM } = await import("../src/features/crm/leads/data/leads-db.js");
const sql = neon(process.env.DATABASE_URL!);

// LIMIT 0 would still plan the statement and catch a bad column, but a real
// row also proves the join returns what the projection expects.
// Pass a public id to check a specific lead; otherwise the newest.
const want = process.argv[2] ?? null;
const stmt = want
  ? `SELECT ${LEAD_SELECT} ${LEAD_FROM} WHERE l.public_id = $1`
  : `SELECT ${LEAD_SELECT} ${LEAD_FROM} ORDER BY l.id DESC LIMIT 1`;
const rows = (await sql.query(stmt, want ? [want] : [])) as Array<Record<string, unknown>>;
const r = rows[0];
if (!r) {
  console.log("no leads in this database — the statement still planned, which is the main point");
  process.exit(0);
}
console.log(`LEAD_SELECT ran. ${Object.keys(r).length} columns, lead ${r.public_id}`);
for (const k of Object.keys(r).filter((k) => k.startsWith("gf_")))
  console.log("  " + k.padEnd(24), JSON.stringify(r[k]));
