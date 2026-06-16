/** READ-ONLY: find group-function quotes whose day-of Square order total no longer
 *  matches the contract total — the "repriced after deposit, day-of order never
 *  rebuilt" class of bug (H1174). Scans active/settled quotes with a day-of order. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, "Square-Version": "2024-12-18" };
const d = (c: number) => `$${(c / 100).toFixed(2)}`;
const TOL = 50;
const { sql } = await import("@/lib/db");
const q = sql();

const rows = (await q`
  SELECT id, contract_short_id, event_number, event_name, center_code, status,
         total_cents, square_dayof_order_id, event_date
  FROM group_function_quotes
  WHERE square_dayof_order_id IS NOT NULL
    AND total_cents > 0
    AND status IN ('deposit_paid','resign_required','balance_charged','balance_link_sent','completed')
    AND event_date >= NOW() - INTERVAL '30 days'
  ORDER BY event_date ASC
`) as Array<Record<string, unknown>>;

console.log(`scanning ${rows.length} quotes with a day-of order (event within last 30d or future)…\n`);
let mismatches = 0;
for (const r of rows) {
  const oid = String(r.square_dayof_order_id);
  let total = -1;
  try {
    const j = await (await fetch(`${BASE}/orders/${oid}`, { headers: H })).json();
    total = j.order?.total_money?.amount ?? -1;
  } catch { /* ignore */ }
  const diff = total < 0 ? NaN : Math.abs(total - (r.total_cents as number));
  const flag = total < 0 ? "⚠️ FETCH-FAIL" : diff > TOL ? "❌ MISMATCH" : "✅";
  if (total < 0 || diff > TOL) {
    mismatches++;
    console.log(`${flag} #${r.id} ${r.event_number} "${r.event_name}" ${r.center_code} ${r.status}  contract=${d(r.total_cents as number)}  dayof=${total < 0 ? "?" : d(total)}  evt=${String(r.event_date).slice(0, 24)}`);
  }
}
console.log(`\n${mismatches} mismatched/unfetchable of ${rows.length}.`);
process.exit(0);
