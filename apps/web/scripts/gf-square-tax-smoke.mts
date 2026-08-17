/**
 * READ-ONLY smoke for the day-of tax/service-charge shape. Drives the SHIPPED
 * buildDayofOrderShape over real contracts and prices each result through
 * POST /v2/orders/calculate, which persists nothing.
 *
 * Passing means, for every event:
 *   - Square's total_tax_money  == our quote.tax_cents   (tax is finally IN the tax slot)
 *   - Square's total_service_charge_money == the contract service charge
 *   - Square's total_money      == quote.total_cents within the 50c reconcile tolerance
 *     (so the loaded gift card still covers the order staff redeem against)
 *
 *   npx tsx scripts/gf-square-tax-smoke.mts [limitPerCenter]
 *
 * Run from apps/web. NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
// Dynamic, not static: this is a .mts entry and Node's ESM linker cannot see a .ts
// module's named exports through the tsx loader at link time. Still the SHIPPED builder.
type GfTaxProduct = import("../lib/gf-square-tax").GfTaxProduct;
const { buildDayofOrderShape } = await import("../lib/gf-square-tax");

const sql = neon(process.env.DATABASE_URL!);
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN!}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
const TOLERANCE = 50;
const PER_CENTER = Number(process.argv[2] || "25");
const SC_PLU = "IBXWNWIZRCEY4B4RXK4JXD5G";

const rows = (await sql`
  select event_number, center_code, square_location_id, line_items,
         tax_cents, total_cents, is_tax_exempt
  from group_function_quotes
  where line_items is not null and square_location_id is not null
  order by created_at desc
`) as Array<{
  event_number: string | null;
  center_code: string;
  square_location_id: string;
  line_items: GfTaxProduct[];
  tax_cents: number;
  total_cents: number;
  is_tax_exempt: boolean;
}>;

const perCenter = new Map<string, number>();
const sample = rows.filter((r) => {
  const n = perCenter.get(r.center_code) ?? 0;
  if (n >= PER_CENTER) return false;
  perCenter.set(r.center_code, n + 1);
  return true;
});

let pass = 0;
const unmodelled: string[] = [];
const failures: string[] = [];
const contractData: string[] = [];

for (const q of sample) {
  const label = `${q.event_number ?? "?"} ${q.center_code}`;
  const products = (q.line_items || []).filter((x) => x && x.total);
  if (!products.length) continue;

  /**
   * Skip contracts whose OWN line items disagree with themselves: BMI sometimes sends a
   * line whose `total` is not `price × qty` (3482's "Youth Camp Laser Tag": $8.00 × 105
   * but total $8.00). Square is given price and quantity, so it rings price × qty — as
   * does the legacy shape, which builds its lines the same way. Nothing about the tax
   * slots can fix or cause that, so it must not be scored here. Reported separately.
   */
  const priceQtyCents = products.reduce(
    (s, x) => s + Math.round((x.price || 0) * (x.qty || 1) * 100),
    0,
  );
  const lineTotalCents = products.reduce((s, x) => s + Math.round((x.total || 0) * 100), 0);
  if (Math.abs(priceQtyCents - lineTotalCents) > 2) {
    contractData.push(
      `${label}: line items sum ${$(lineTotalCents)} but price×qty ${$(priceQtyCents)}`,
    );
    continue;
  }

  const shape = buildDayofOrderShape({
    centerCode: q.center_code,
    locationId: q.square_location_id,
    products,
    taxExempt: q.is_tax_exempt,
  });
  if (!shape) {
    unmodelled.push(label);
    continue;
  }

  const res = await fetch("https://connect.squareup.com/v2/orders/calculate", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ order: { location_id: q.square_location_id, ...shape } }),
  });
  const data = await res.json();
  if (!res.ok) {
    failures.push(`${label}: HTTP ${res.status} ${JSON.stringify(data.errors ?? data)}`);
    continue;
  }
  const o = data.order;
  const sqTax = o.total_tax_money?.amount ?? 0;
  const sqSvc = o.total_service_charge_money?.amount ?? 0;
  const sqTotal = o.total_money?.amount ?? 0;
  const scLine = products.find(
    (x) => x.plu === SC_PLU || /service\s*charge/i.test(String(x.name || "")),
  );
  const contractSc = Math.round((scLine?.total || 0) * 100);

  const problems: string[] = [];
  if (Math.abs(sqTax - q.tax_cents) > 2)
    problems.push(`tax ${$(sqTax)} != contract ${$(q.tax_cents)}`);
  if (Math.abs(sqSvc - contractSc) > 2)
    problems.push(`svc ${$(sqSvc)} != contract ${$(contractSc)}`);
  if (Math.abs(sqTotal - q.total_cents) > TOLERANCE)
    problems.push(`total ${$(sqTotal)} != contract ${$(q.total_cents)} (>${TOLERANCE}c)`);
  // The whole point: tax must no longer be hiding in a service charge.
  if (q.tax_cents > 0 && sqTax === 0) problems.push("tax still $0 in Square");

  if (problems.length) {
    failures.push(`${label}: ${problems.join("; ")}`);
  } else {
    pass++;
    const drift = sqTotal - q.total_cents;
    console.log(
      `  ok  ${label.padEnd(22)} svc=${$(sqSvc).padStart(9)} tax=${$(sqTax).padStart(9)} total=${$(sqTotal).padStart(10)}${drift ? `  (drift ${drift}c)` : ""}`,
    );
  }
}

console.log(
  `\n=== ${pass} passed, ${failures.length} failed, ${unmodelled.length} not modelled, ` +
    `${contractData.length} skipped (contract data) ===`,
);
if (contractData.length) {
  console.log(`\nPRE-EXISTING contract-data problems — same under the legacy shape:`);
  for (const c of contractData) console.log(`  ${c}`);
}
if (unmodelled.length) {
  console.log(`\nnot modelled (these keep the legacy shape, which still totals correctly):`);
  for (const u of unmodelled.slice(0, 20)) console.log(`  ${u}`);
  if (unmodelled.length > 20) console.log(`  … +${unmodelled.length - 20} more`);
}
if (failures.length) {
  console.log(`\nFAILURES:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
