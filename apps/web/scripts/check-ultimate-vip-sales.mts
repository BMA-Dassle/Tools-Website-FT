/**
 * Count Ultimate VIP Experience combo sales. A combo day-of order's line is
 * EITHER ad-hoc named "Ultimate VIP Experience" (pre-catalog-link bookings)
 * OR a catalog line on the Ultimate Qualifier item X4RZPTPJEJ45OG3S3HMDMCHZ
 * with a $65/$75 per-person base price override (post-link). Paginates the
 * whole window. Read-only.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("SQUARE_ACCESS_TOKEN missing in .env.local");
  process.exit(1);
}

const LOCATIONS = ["TXBSQN0FEKQ11", "LAB52GY480CJF"]; // HP FM + FastTrax FM
const UQ_CATALOG = "X4RZPTPJEJ45OG3S3HMDMCHZ";
const COMBO_UNITS = new Set([6500, 7500]);

interface Line {
  name?: string;
  quantity?: string;
  catalog_object_id?: string;
  base_price_money?: { amount: number };
  total_money?: { amount: number };
}
interface Order {
  id: string;
  location_id: string;
  state: string;
  created_at: string;
  total_money?: { amount: number };
  tenders?: Array<{ type: string }>;
  line_items?: Line[];
}

function isComboLine(li: Line): boolean {
  if ((li.name ?? "").includes("Ultimate VIP Experience")) return true;
  return (
    li.catalog_object_id === UQ_CATALOG &&
    li.base_price_money != null &&
    COMBO_UNITS.has(li.base_price_money.amount)
  );
}

let cursor: string | undefined;
let scanned = 0;
let earliest = "";
const hits: Order[] = [];
do {
  const res = await fetch("https://connect.squareup.com/v2/orders/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      location_ids: LOCATIONS,
      limit: 200,
      cursor,
      query: {
        filter: { date_time_filter: { created_at: { start_at: "2026-06-10T00:00:00-04:00" } } },
        sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
      },
    }),
  });
  const data = (await res.json()) as { orders?: Order[]; cursor?: string; errors?: unknown };
  if (!res.ok || data.errors) {
    console.error("Square search failed:", JSON.stringify(data.errors ?? data));
    process.exit(1);
  }
  for (const o of data.orders ?? []) {
    scanned += 1;
    earliest = o.created_at;
    if (o.line_items?.some(isComboLine)) hits.push(o);
  }
  cursor = data.cursor;
} while (cursor);

console.log(`Scanned ${scanned} orders (back to ${earliest})`);
console.log(`Ultimate VIP Experience orders: ${hits.length}\n`);
for (const o of hits) {
  const vipLines = (o.line_items ?? []).filter(isComboLine);
  const persons = vipLines.reduce((s, li) => s + Number(li.quantity ?? 0), 0);
  console.log(
    `${o.created_at}  ${o.id}  loc=${o.location_id}  state=${o.state}  ` +
      `persons=${persons}  order_total=$${((o.total_money?.amount ?? 0) / 100).toFixed(2)}  ` +
      `tendered=${o.tenders?.length ? "YES" : "no"}`,
  );
}
