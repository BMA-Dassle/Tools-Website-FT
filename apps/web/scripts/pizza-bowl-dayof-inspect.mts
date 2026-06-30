/** Reconcile Pizza Bowl 6/14: paid website orders vs $0 front-desk (Terminal/Conqueror) lane tickets. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const BASE = "https://connect.squareup.com/v2";
const PB = "GWQQDLD5J3XAZAOU5STJL3VF";
const PB_VIP = "3BET7DOSFNF64GNPMOZTI5SJ";
const PIZZA_FOOD = new Set(["2IKZB4O2HQBXWMTSUQ2SEKJY" /*Pizza*/, "SJUBJLB4QGHIHCW5AKTTMLH7" /*Soda Pitcher*/]);

const LOCATIONS = ["TXBSQN0FEKQ11", "PPTR5G2N0QXF7"];
const locs = await (await fetch(`${BASE}/locations`, { headers: H })).json();
const locName: Record<string, string> = {};
for (const l of locs.locations ?? []) locName[l.id] = l.name;

const orders: any[] = [];
let cursor: string | undefined;
do {
  const res = await (
    await fetch(`${BASE}/orders/search`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        location_ids: LOCATIONS,
        cursor,
        query: {
          filter: { date_time_filter: { created_at: { start_at: "2026-06-14T00:00:00-04:00", end_at: "2026-06-15T06:00:00-04:00" } } },
          sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
        },
        limit: 500,
      }),
    })
  ).json();
  orders.push(...(res.orders ?? []));
  cursor = res.cursor;
} while (cursor);
console.log(`Total 6/14 orders: ${orders.length}`);

const liHas = (o: any, catSet: Set<string>) => (o.line_items ?? []).some((li: any) => li.catalog_object_id && catSet.has(li.catalog_object_id));
const liHasName = (o: any, re: RegExp) => (o.line_items ?? []).some((li: any) => re.test(li.name ?? ""));

// A: website-source orders carrying the catalog-linked Pizza Bowl base
const website = orders.filter((o: any) => /Website/i.test(o.source?.name ?? "") && liHas(o, new Set([PB, PB_VIP])));
const websitePaid = website.filter((o: any) => (o.total_money?.amount ?? 0) > 0);
const websiteZero = website.filter((o: any) => (o.total_money?.amount ?? 0) === 0);
const websiteRev = websitePaid.reduce((s: number, o: any) => s + (o.total_money?.amount ?? 0), 0);

// B: front-desk (Terminal) $0 lane tickets carrying Pizza Bowl food
const deskZero = orders.filter(
  (o: any) => /Terminal/i.test(o.source?.name ?? "") && (o.total_money?.amount ?? 0) === 0 && liHas(o, PIZZA_FOOD),
);

console.log(`\n=== A. WEBSITE Pizza Bowl orders (base catalog ${PB.slice(0, 6)}…): ${website.length} ===`);
console.log(`    paid (>$0): ${websitePaid.length}   revenue=$${(websiteRev / 100).toFixed(2)}`);
console.log(`    $0 website orders: ${websiteZero.length}  <-- THESE would be the real bug (food, no charge)`);
for (const o of websiteZero) console.log(`      ⚠ ${o.id}  ${o.created_at}  ${locName[o.location_id]}`);

console.log(`\n=== B. FRONT-DESK (Terminal) $0 lane tickets with Pizza Bowl food: ${deskZero.length} ===`);
const bySrc: Record<string, number> = {};
for (const o of deskZero) bySrc[o.source?.name ?? "?"] = (bySrc[o.source?.name ?? "?"] ?? 0) + 1;
console.log(`    sources: ${JSON.stringify(bySrc)}`);

console.log(`\n=== Source breakdown of ALL orders touching Pizza Bowl food/base ===`);
const touch = orders.filter((o: any) => liHas(o, PIZZA_FOOD) || liHas(o, new Set([PB, PB_VIP])));
const srcCount: Record<string, { n: number; paid: number }> = {};
for (const o of touch) {
  const s = o.source?.name ?? "?";
  srcCount[s] ??= { n: 0, paid: 0 };
  srcCount[s].n++;
  if ((o.total_money?.amount ?? 0) > 0) srcCount[s].paid++;
}
for (const [s, v] of Object.entries(srcCount)) console.log(`    ${s}: ${v.n} orders (${v.paid} with $ > 0)`);
