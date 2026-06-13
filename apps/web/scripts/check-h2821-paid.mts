/** Exit 0 + print row when H2821 (quote 119) has dayof_paid_at set; else exit 1. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const rows = (await q`
  SELECT id, event_number, status, dayof_paid_at, dayof_payment_ids, dayof_payment_error
  FROM group_function_quotes WHERE id = 119
`) as Array<Record<string, unknown>>;
if (rows[0]?.dayof_paid_at) {
  console.log("H2821 PAID: " + JSON.stringify(rows[0]));
  process.exit(0);
}
console.error("not yet: " + JSON.stringify(rows[0]?.dayof_payment_error));
process.exit(1);
