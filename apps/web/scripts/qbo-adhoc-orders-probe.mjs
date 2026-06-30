// READ-ONLY: scan recent Square orders and tally line items by name, reporting
// whether each carries a catalog_object_id (=> has a category) or is ad-hoc
// (=> no category => imports to QBO individually). Confirms the root cause of
// the "bunch of items" in the QBO journal sync. NO changes made.
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

// All active locations
const locRes = await fetch(`${BASE}/locations`, { headers: H });
const locBody = await locRes.json();
const locIds = (locBody.locations || []).filter((l) => l.status === "ACTIVE").map((l) => l.id);
console.log(`Scanning ${locIds.length} active locations, last 90 days.\n`);

const start = "2026-03-17T00:00:00Z"; // ~90d before 2026-06-15
const tally = new Map(); // name -> {linked, adhoc, total, money}
let orders = 0;
let cursor;
do {
  const body = {
    location_ids: locIds,
    query: {
      filter: { date_time_filter: { created_at: { start_at: start } } },
      sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
    },
    limit: 500,
    ...(cursor ? { cursor } : {}),
  };
  const r = await fetch(`${BASE}/orders/search`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(body),
  });
  const b = await r.json();
  if (b.errors) {
    console.error(JSON.stringify(b.errors));
    break;
  }
  for (const o of b.orders || []) {
    orders++;
    for (const li of o.line_items || []) {
      const nm = li.name || "(unnamed)";
      const t = tally.get(nm) || { linked: 0, adhoc: 0, total: 0, money: 0 };
      t.total++;
      t.money += li.total_money?.amount || 0;
      if (li.catalog_object_id) t.linked++;
      else t.adhoc++;
      tally.set(nm, t);
    }
  }
  cursor = b.cursor;
} while (cursor);

console.log(`Scanned ${orders} orders.\n`);

const RACE = /race|racer|qualifier|rookie|starter|pov|pack/i;
console.log("=== Race-related line items: ad-hoc (no catalog link) vs linked ===");
const rows = [...tally.entries()]
  .filter(([nm]) => RACE.test(nm))
  .sort((a, b) => b[1].adhoc - a[1].adhoc);
for (const [nm, t] of rows) {
  const flag = t.adhoc > 0 ? (t.linked === 0 ? "  ⚠ ALL AD-HOC" : "  ⚠ MIXED") : "";
  console.log(`  ${t.adhoc}/${t.total} ad-hoc  $${(t.money / 100).toFixed(2)}  "${nm}"${flag}`);
}

console.log("\n=== Top 25 ad-hoc line items overall (any name, no catalog link) ===");
const adhocRows = [...tally.entries()]
  .filter(([, t]) => t.adhoc > 0)
  .sort((a, b) => b[1].adhoc - a[1].adhoc)
  .slice(0, 25);
for (const [nm, t] of adhocRows) {
  console.log(`  ${t.adhoc} ad-hoc / ${t.total} total  $${(t.money / 100).toFixed(2)}  "${nm}"`);
}
