/** Dump line items + totals for the untendered combo orders, to understand original pricing. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18" };
const ORDERS = ["ta8ExW2mU4spvqKtBcdDlkkAiQ6YY", "vRrKnIKBrUamE1dvZTPWib954SIZY"];
for (const id of ORDERS) {
  const o = (await (await fetch(`https://connect.squareup.com/v2/orders/${id}`, { headers: H })).json()).order;
  console.log(`\n=== ${id} ===  state=${o.state} loc=${o.location_id}`);
  for (const li of o.line_items ?? []) {
    console.log(
      `  ${li.quantity} × ${li.name}  base=$${((li.base_price_money?.amount ?? 0) / 100).toFixed(2)}  gross=$${((li.gross_sales_money?.amount ?? 0) / 100).toFixed(2)}  total=$${((li.total_money?.amount ?? 0) / 100).toFixed(2)}  catalog=${li.catalog_object_id ?? "-"}`,
    );
  }
  for (const sc of o.service_charges ?? []) {
    console.log(`  [svc charge] ${sc.name}  $${((sc.total_money?.amount ?? 0) / 100).toFixed(2)}  taxable=${sc.taxable}`);
  }
  for (const t of o.taxes ?? []) {
    console.log(`  [tax] ${t.name ?? t.uid}  ${t.percentage}%  $${((t.applied_money?.amount ?? 0) / 100).toFixed(2)}`);
  }
  for (const d of o.discounts ?? []) {
    console.log(`  [discount] ${d.name}  $${((d.applied_money?.amount ?? 0) / 100).toFixed(2)}`);
  }
  console.log(`  SUBTOTAL via total_money: $${((o.total_money?.amount ?? 0) / 100).toFixed(2)}  tax=$${((o.total_tax_money?.amount ?? 0) / 100).toFixed(2)}  svc=$${((o.total_service_charge_money?.amount ?? 0) / 100).toFixed(2)}`);
}
