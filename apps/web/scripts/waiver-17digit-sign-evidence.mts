// READ-ONLY: has any Pandora waiver sign been attempted/succeeded with a
// 17-digit Office person id? Settles roster-preload.ts "NOT ESTABLISHED"
// before signInRows rows are routed to direct signing (owner 2026-07-31).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const agg = await sql`
  SELECT length(person_id) AS id_len, outcome, count(*) AS n, max(ts) AS latest
  FROM waiver_sign_attempts GROUP BY 1, 2 ORDER BY 1, 2`;
console.table(agg);
const long = await sql`
  SELECT person_id, outcome, http_status, left(coalesce(upstream_message,''),140) AS upstream, ts
  FROM waiver_sign_attempts WHERE length(person_id) > 12
  ORDER BY ts DESC LIMIT 10`;
console.log(JSON.stringify(long, null, 1));
