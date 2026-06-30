// READ-ONLY audit: list every Square catalog ITEM and report whether it has a
// category / reporting_category assigned. Items with NO category are what a
// Square->QBO journal-entry sync tool surfaces individually under "Sales
// (Categories)" instead of rolling them up under a category GL account.
// Makes NO changes to Square.
import fs from "fs";

const env = fs.readFileSync("c:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const tok = env
  .match(/^SQUARE_ACCESS_TOKEN=(.+)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${tok}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};

// 1) Pull all CATEGORY objects so we can resolve ids -> names.
const catName = new Map();
{
  let cursor;
  do {
    const url = new URL(`${BASE}/catalog/list`);
    url.searchParams.set("types", "CATEGORY");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: H });
    const body = await res.json();
    for (const o of body.objects || []) {
      catName.set(o.id, o.category_data?.name || "(unnamed category)");
    }
    cursor = body.cursor;
  } while (cursor);
}
console.log(`Loaded ${catName.size} categories.\n`);

// 2) Walk every ITEM, classify category assignment.
const noCat = [];
const withCat = [];
let total = 0;
let cursor;
do {
  const url = new URL(`${BASE}/catalog/list`);
  url.searchParams.set("types", "ITEM");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url, { headers: H });
  const body = await res.json();
  for (const o of body.objects || []) {
    total++;
    const d = o.item_data || {};
    // Square has THREE places a category can live; the newest is the source of truth:
    //  - item_data.reporting_category.id  (what reporting/QBO syncs key off)
    //  - item_data.categories[]           (multi-category, newer API)
    //  - item_data.category_id            (legacy single category)
    const reportingId = d.reporting_category?.id || null;
    const catIds = (d.categories || []).map((c) => c.id);
    const legacyId = d.category_id || null;
    const anyId = reportingId || catIds[0] || legacyId || null;

    const rec = {
      name: d.name,
      id: o.id,
      reportingId,
      catIds,
      legacyId,
      catName: anyId ? catName.get(anyId) || `(id ${anyId} not in category list)` : null,
    };
    if (!anyId) noCat.push(rec);
    else withCat.push(rec);
  }
  cursor = body.cursor;
} while (cursor);

console.log(
  `Scanned ${total} items: ${withCat.length} categorized, ${noCat.length} UNCATEGORIZED.\n`,
);

console.log("=== ITEMS WITH NO CATEGORY (these import to QBO individually) ===");
for (const r of noCat.sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
  console.log(`  • ${r.name}`);
}

console.log(
  "\n=== Items missing reporting_category specifically (have legacy/multi but no reporting) ===",
);
for (const r of withCat
  .filter((r) => !r.reportingId)
  .sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
  console.log(
    `  • ${r.name}  ->  legacy=${r.legacyId || "-"} multi=[${r.catIds.join(",") || "-"}] (${r.catName})`,
  );
}
