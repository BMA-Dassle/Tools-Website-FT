/** Find the POV / ViewPoint Square catalog item (+ verify the combo line
 *  catalog ids resolve to variations with prices). Read-only. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// 1) Search items by name for POV / ViewPoint / Video.
const search = await fetch("https://connect.squareup.com/v2/catalog/search-catalog-items", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ text_filter: "POV", limit: 50 }),
});
const sdata = (await search.json()) as { items?: Array<{ id: string; item_data?: { name?: string; variations?: Array<{ id: string; item_variation_data?: { name?: string; price_money?: { amount?: number } } }> } }>; errors?: unknown };
console.log("=== search 'POV' ===", sdata.errors ? JSON.stringify(sdata.errors) : "");
for (const it of sdata.items ?? []) {
  console.log(`ITEM ${it.id} "${it.item_data?.name}"`);
  for (const v of it.item_data?.variations ?? [])
    console.log(`   var ${v.id} "${v.item_variation_data?.name}" $${((v.item_variation_data?.price_money?.amount ?? 0) / 100).toFixed(2)}`);
}

for (const term of ["ViewPoint", "Video", "View Point"]) {
  const r = await fetch("https://connect.squareup.com/v2/catalog/search-catalog-items", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text_filter: term, limit: 25 }),
  });
  const d = (await r.json()) as { items?: Array<{ id: string; item_data?: { name?: string; variations?: Array<{ id: string; item_variation_data?: { name?: string; price_money?: { amount?: number } } }> } }> };
  console.log(`\n=== search '${term}' ===`);
  for (const it of d.items ?? []) {
    console.log(`ITEM ${it.id} "${it.item_data?.name}"`);
    for (const v of it.item_data?.variations ?? [])
      console.log(`   var ${v.id} "${v.item_variation_data?.name}" $${((v.item_variation_data?.price_money?.amount ?? 0) / 100).toFixed(2)}`);
  }
}

// 2) Verify the combo line catalog ids (these are stored as catalog_object_id on
//    day-of order lines, so they should be VARIATION ids).
console.log("\n=== verify combo line catalog ids (batch-retrieve) ===");
const ids = [
  "X4RZPTPJEJ45OG3S3HMDMCHZ", // Ultimate Qualifier
  "R66TY2VTICYUH4NM3F4UQVLF", // VIP Bowling
  "BVJ2ZSW6N4FPSPSPSB4IN7LA", // Shoes $5
  "7GUST7MZ25TOBOB4UXPDYPV4", // License
  "5FINJYYPPELXTERF2THUDCPT", // Karting
];
const batch = await fetch("https://connect.squareup.com/v2/catalog/batch-retrieve", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ object_ids: ids, include_related_objects: false }),
});
const bdata = (await batch.json()) as { objects?: Array<{ id: string; type: string; item_variation_data?: { name?: string; price_money?: { amount?: number } }; item_data?: { name?: string } }>; errors?: unknown };
if (bdata.errors) console.log("batch errors:", JSON.stringify(bdata.errors));
for (const o of bdata.objects ?? []) {
  const nm = o.item_variation_data?.name ?? o.item_data?.name ?? "?";
  const px = o.item_variation_data?.price_money?.amount;
  console.log(`  ${o.id} type=${o.type} "${nm}"${px != null ? ` $${(px / 100).toFixed(2)}` : ""}`);
}
