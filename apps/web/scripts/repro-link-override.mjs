// READ-ONLY: settle the "can you link AND override the price?" question with Square's
// /orders/calculate (validates pricing; creates nothing, charges nothing).
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

// A real location to validate against.
const [loc] =
  await sql`SELECT square_location_id FROM group_function_quotes WHERE center_code='fasttrax' AND square_location_id IS NOT NULL LIMIT 1`;
const LOC = loc.square_location_id;

// LPOH... = "Race Blue Starter" FIXED_PRICING @ $26.99. We send base_price_money $399.99.
const RACE = "LPOHFAIUE72CMYX7SLSMLMDO";

console.log(
  "=== TEST 1: FIXED catalog item ($26.99) linked + base_price_money override ($399.99) ===",
);
const t1 = await fetch(`${BASE}/orders/calculate`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    order: {
      location_id: LOC,
      line_items: [
        {
          catalog_object_id: RACE,
          quantity: "1",
          base_price_money: { amount: 39999, currency: "USD" },
        },
      ],
    },
  }),
});
const d1 = await t1.json();
if (!t1.ok) console.log("  status", t1.status, "ERRORS:", JSON.stringify(d1.errors));
else
  for (const it of d1.order.line_items || [])
    console.log(
      `  -> "${it.name}" catalog=${it.catalog_object_id ? "YES" : "no"} base=${d(it.base_price_money?.amount)} GROSS=${d(it.gross_sales_money?.amount)} total=${d(it.total_money?.amount)}`,
    );

console.log(
  "\n=== TEST 2: same FIXED catalog item, NO base_price_money (control — expect $26.99) ===",
);
const t2 = await fetch(`${BASE}/orders/calculate`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    order: { location_id: LOC, line_items: [{ catalog_object_id: RACE, quantity: "1" }] },
  }),
});
const d2 = await t2.json();
if (!t2.ok) console.log("  status", t2.status, "ERRORS:", JSON.stringify(d2.errors));
else
  for (const it of d2.order.line_items || [])
    console.log(
      `  -> "${it.name}" base=${d(it.base_price_money?.amount)} total=${d(it.total_money?.amount)}`,
    );

console.log(
  "\nVERDICT: if TEST 1 total = $399.99, link+override WORKS (code assumption is wrong).",
);
console.log("         if TEST 1 total = $26.99, Square ignored our price (code assumption holds).");
