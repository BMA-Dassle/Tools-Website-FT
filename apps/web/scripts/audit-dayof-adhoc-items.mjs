// READ-ONLY audit: scan every group-function day-of Square order and flag any
// line item that is NOT linked to a Square catalog object (ad-hoc / one-time
// custom-amount item). Makes NO changes.
import fs from "fs";
import { neon } from "@neondatabase/serverless";

const env = fs.readFileSync("c:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const tok = env
  .match(/^SQUARE_ACCESS_TOKEN=(.+)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const sql = neon(
  "postgresql://neondb_owner:npg_j2dvUJEB0STo@ep-odd-frog-am0i4stu-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require",
);
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${tok}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const d = (c) => `$${((c || 0) / 100).toFixed(2)}`;

const rows = await sql`
  SELECT id, event_number, event_name, center_code, event_date, status,
         square_location_id, square_dayof_order_id
  FROM group_function_quotes
  WHERE square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
    AND status NOT IN ('cancelled', 'denied')
  ORDER BY event_date ASC
`;

console.log(`Scanning ${rows.length} day-of Square order(s)...\n`);

const flagged = [];
let scanned = 0,
  errored = 0;

for (const q of rows) {
  let ord;
  try {
    const res = await fetch(`${BASE}/orders/${q.square_dayof_order_id}`, { headers: H });
    const body = await res.json();
    ord = body.order;
    if (!ord) {
      errored++;
      console.log(
        `  [ERR] #${q.event_number} ${q.event_name} order ${q.square_dayof_order_id}: ${JSON.stringify(body).slice(0, 120)}`,
      );
      continue;
    }
  } catch (e) {
    errored++;
    console.log(`  [ERR] #${q.event_number} ${q.event_name}: ${e.message}`);
    continue;
  }
  scanned++;

  const items = ord.line_items || [];
  const adhoc = items.filter((it) => !it.catalog_object_id);
  if (adhoc.length === 0) continue;

  flagged.push({ q, ord, adhoc, total: items.length });
}

console.log(`\n=== DAY-OF ORDERS WITH AD-HOC (NON-CATALOG) LINE ITEMS ===`);
console.log(`Scanned OK: ${scanned}   Errored: ${errored}   Flagged: ${flagged.length}\n`);

let adhocDollars = 0;
for (const f of flagged) {
  const { q, ord, adhoc, total } = f;
  console.log(
    `  [quote ${q.id}] #${q.event_number || "?"} ${q.event_name || "(unnamed)"} — ${q.center_code}  ${q.event_date || ""}  status=${q.status}`,
  );
  console.log(
    `     order ${q.square_dayof_order_id}  state=${ord.state}  total=${d(ord.total_money?.amount)}  (${adhoc.length}/${total} line items ad-hoc)`,
  );
  for (const it of adhoc) {
    const amt = it.base_price_money?.amount || 0;
    adhocDollars += it.total_money?.amount || amt * Number(it.quantity || 1);
    console.log(
      `       • ${it.quantity}x "${it.name}" @ ${d(amt)}  -> line total ${d(it.total_money?.amount)}  [NO catalog_object_id]`,
    );
  }
  console.log("");
}

console.log(`=== TOTALS ===`);
console.log(`Day-of orders with >=1 ad-hoc line item: ${flagged.length}`);
console.log(`Sum of ad-hoc line totals: ${d(adhocDollars)}`);
