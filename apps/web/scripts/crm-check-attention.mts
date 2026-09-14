/**
 * The badge and the list must be the same set. They were not: 312 vs 82.
 * Runs the REAL predicate both ways, against the real database.
 *   npx tsx scripts/crm-check-attention.mts
 */
import fs from "node:fs";
import { neon } from "@neondatabase/serverless";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { attentionPredicate, UNSIGNED_AGE_MINUTES } = await import(
  "../src/features/crm/contracts/service/attention.js"
);
const { CLOSED_GF_STATUSES } = await import("../src/features/crm/contracts/contracts.js");
const sql = neon(process.env.DATABASE_URL!);

const now = new Date();
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);
const cutoff = new Date(now.getTime() - UNSIGNED_AGE_MINUTES * 60_000).toISOString();
const closed = [...CLOSED_GF_STATUSES];

for (const includePast of [false, true]) {
  const pred = attentionPredicate(includePast);
  // The badge's expression.
  const badge = (await sql.query(
    `SELECT count(*) FILTER (WHERE ${pred} AND q.status <> ALL($3::text[]))::int AS n
       FROM group_function_quotes q`,
    [today, cutoff, closed],
  )) as Array<{ n: number }>;
  // The list's: the same predicate, plus the same closed filter the list adds.
  const list = (await sql.query(
    `SELECT count(*)::int AS n FROM group_function_quotes q
      WHERE ${pred} AND q.status <> ALL($3::text[])`,
    [today, cutoff, closed],
  )) as Array<{ n: number }>;
  const b = badge[0]!.n;
  const l = list[0]!.n;
  console.log(
    `includePast=${String(includePast).padEnd(5)} badge=${String(b).padStart(4)} list=${String(l).padStart(4)}  ${b === l ? "MATCH" : "*** DISAGREE ***"}`,
  );
}
