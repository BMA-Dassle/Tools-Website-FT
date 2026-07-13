/**
 * READ-ONLY: Did anything close day-of Square orders for FUTURE reservations?
 * Scans bowling_reservations (all product kinds incl. combo legs) and
 * group_function_quotes with an event date today or later, retrieves each
 * day-of order from Square, and reports any whose state is not OPEN
 * (with closed_at so a batch-close event is visible).
 *   node apps/web/scripts/future-dayof-closed-audit.mts
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* next */
  }
}
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const TODAY = "2026-07-08";
const CONCURRENCY = 6;
const D = (c: number) => `$${(c / 100).toFixed(2)}`;

function* orderIds(raw: string): Generator<string> {
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) {
      for (const x of p) if (x) yield String(x);
      return;
    }
  } catch {
    /* bare id */
  }
  yield raw;
}

type Item = { src: string; refId: number; kind: string; guest: string; day: string; resStatus: string; orderId: string };
const items: Item[] = [];
const seen = new Set<string>();
function add(src: string, refId: number, kind: string, guest: string, day: string, resStatus: string, raw: string) {
  for (const id of orderIds(raw)) {
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ src, refId, kind, guest, day, resStatus, orderId: id });
  }
}

const br = (await sql`
  SELECT id, product_kind, guest_name, status, square_dayof_order_id,
         to_char((booked_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date >= ${TODAY}::date
    AND status != 'cancelled'
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
  ORDER BY booked_at
`) as any[];
for (const r of br)
  add("res", r.id, r.product_kind ?? "?", r.guest_name ?? "", String(r.day), r.status, r.square_dayof_order_id);

const gf = (await sql`
  SELECT id, event_name, event_number, status, square_dayof_order_id,
         to_char(event_date::date, 'YYYY-MM-DD') AS day
  FROM group_function_quotes
  WHERE event_date::date >= ${TODAY}::date
    AND status NOT IN ('cancelled','denied')
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
  ORDER BY event_date
`) as any[];
for (const r of gf)
  add("gf", r.id, "group", `${r.event_name ?? ""} #${r.event_number ?? "?"}`, String(r.day), r.status, r.square_dayof_order_id);

console.log(`Future (>= ${TODAY}) day-of orders to verify: ${items.length}  (reservations: ${br.length}, group events: ${gf.length})\n`);

type Result = Item & { state: string; total: number; due: number; closedAt: string };
const results: Result[] = [];
let idx = 0;
async function worker() {
  while (idx < items.length) {
    const it = items[idx++];
    try {
      const res = await fetch(`${BASE}/orders/${it.orderId}`, { headers: H });
      const o = (await res.json().catch(() => ({}))).order;
      if (!o) {
        results.push({ ...it, state: "FETCH_FAIL", total: 0, due: 0, closedAt: "" });
        continue;
      }
      results.push({
        ...it,
        state: o.state ?? "?",
        total: o.total_money?.amount ?? 0,
        due: o.net_amount_due_money?.amount ?? 0,
        closedAt: (o.closed_at ?? "").slice(0, 19),
      });
    } catch (err) {
      results.push({ ...it, state: `ERR ${err instanceof Error ? err.message : err}`, total: 0, due: 0, closedAt: "" });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const byState: Record<string, number> = {};
for (const r of results) byState[r.state] = (byState[r.state] ?? 0) + 1;
console.log("Order states:");
for (const [s, n] of Object.entries(byState).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);

const bad = results.filter((r) => r.state !== "OPEN").sort((a, b) => (a.day < b.day ? -1 : 1));
if (!bad.length) {
  console.log("\nAll future day-of orders are still OPEN. Nothing was closed.");
} else {
  console.log(`\nNOT OPEN (${bad.length}):`);
  for (const r of bad)
    console.log(
      `  ${r.day}  ${r.src}#${r.refId} [${r.kind}/${r.resStatus}] ${r.guest}  ${r.state}  total=${D(r.total)} due=${D(r.due)}  closed_at=${r.closedAt || "-"}  order=${r.orderId}`,
    );
}
process.exit(0);
