/** READ-ONLY: find a GF quote by any identifier fragment. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const FRAG = process.argv[2] ?? "1174";
const { sql } = await import("@/lib/db");
const q = sql();
const like = `%${FRAG}%`;
const rows = (await q`
  SELECT id, contract_short_id, event_number, event_name, center_code, status,
         bmi_reservation_id, total_cents, deposit_due_cents, balance_cents, collected_cents,
         balance_paid_at, event_date
  FROM group_function_quotes
  WHERE event_number ILIKE ${like}
     OR contract_short_id ILIKE ${like}
     OR bmi_reservation_id ILIKE ${like}
     OR event_name ILIKE ${like}
  ORDER BY id DESC
  LIMIT 25
`) as Array<Record<string, unknown>>;
console.log(`matches for "${FRAG}": ${rows.length}`);
for (const r of rows) {
  console.log(
    `#${r.id} short=${r.contract_short_id} evt#=${r.event_number} "${r.event_name}" ${r.center_code} ${r.status} ` +
      `total=$${((r.total_cents as number) / 100).toFixed(2)} dep=$${((r.deposit_due_cents as number) / 100).toFixed(2)} ` +
      `bal=$${((r.balance_cents as number) / 100).toFixed(2)} coll=$${((r.collected_cents as number) / 100).toFixed(2)} ` +
      `paid=${r.balance_paid_at ?? "-"} bmi=${r.bmi_reservation_id}`,
  );
}
process.exit(0);
