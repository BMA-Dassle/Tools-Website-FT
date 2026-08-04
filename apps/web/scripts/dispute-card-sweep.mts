/**
 * READ-ONLY: sweep ALL locations for payments made by the same card.
 * Required before contesting a DUPLICATE — GET /v2/payments without location_id
 * returns only the MAIN location, so we must iterate /v2/locations.
 *
 * Usage: npx tsx scripts/dispute-card-sweep.mts <fingerprint|last4> <beginISO> [endISO]
 */
import { readFileSync } from "node:fs";

if (!process.env.SQUARE_ACCESS_TOKEN) {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^SQUARE_ACCESS_TOKEN=(.+)$/m);
  if (m) process.env.SQUARE_ACCESS_TOKEN = m[1].trim().replace(/^"|"$/g, "");
}
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
async function sq(path: string) {
  const r = await fetch(`${BASE}${path}`, { headers: H });
  const b: any = await r.json();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(b.errors ?? b)}`);
  return b;
}

const [needle, begin, end] = process.argv.slice(2);
if (!needle || !begin) throw new Error("usage: <fingerprint|last4> <beginISO> [endISO]");

const usd = (m?: { amount?: number }) => `$${((m?.amount ?? 0) / 100).toFixed(2)}`;
const locations: any[] = (await sq("/locations")).locations ?? [];
const locName = new Map(locations.map((l) => [l.id, l.name ?? l.id]));

const hits: any[] = [];
let scanned = 0;

for (const loc of locations) {
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ location_id: loc.id, begin_time: begin, limit: "100" });
    if (end) qs.set("end_time", end);
    if (cursor) qs.set("cursor", cursor);
    const page = await sq(`/payments?${qs}`);
    for (const p of (page.payments ?? []) as any[]) {
      scanned++;
      const card = p.card_details?.card ?? {};
      if (card.fingerprint === needle || card.last_4 === needle) hits.push(p);
    }
    cursor = page.cursor;
  } while (cursor);
}

console.log(`Scanned ${scanned} payments across ${locations.length} locations from ${begin}`);
console.log(`Matches for "${needle}": ${hits.length}\n`);

hits.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
for (const p of hits) {
  const card = p.card_details?.card ?? {};
  console.log(`${p.created_at}  ${usd(p.amount_money).padStart(9)}  ${p.status.padEnd(9)} ${p.id}`);
  console.log(`    ${locName.get(p.location_id)} | ${card.card_brand} ****${card.last_4} exp ${card.exp_month}/${card.exp_year} | fp ${card.fingerprint?.slice(0, 24)}…`);
  console.log(`    entry ${p.card_details?.entry_method}  auth ${p.card_details?.auth_result_code}  refunded ${usd(p.refunded_money)}`);
  console.log(`    order ${p.order_id ?? "—"}  note "${p.note ?? "—"}"`);
  console.log("");
}
