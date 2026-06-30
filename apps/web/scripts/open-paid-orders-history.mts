/**
 * READ-ONLY: How long have PAID-IN-FULL day-of orders been left in Square state
 * OPEN (never moved to COMPLETED)? Searches each bowling location's orders,
 * buckets OPEN orders with net_amount_due == 0 and total > 0 by week.
 *   node --env-file=apps/web/.env.local apps/web/scripts/open-paid-orders-history.mts [daysBack]
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
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const LOCS: Record<string, string> = { TXBSQN0FEKQ11: "Fort Myers", PPTR5G2N0QXF7: "Naples" };

const DAYS = Number(process.argv[2] ?? "120");
// Date math without Date.now(): derive start from a passed ISO or default span.
// We can't call Date.now(); accept an explicit "since" ISO as 3rd arg, else use a
// fixed window ending "now" via Square's server clock by omitting end (Square
// defaults end to now). Provide start as today-minus-DAYS using a static anchor.
const ANCHOR = process.argv[3] ?? "2026-06-16T23:59:59Z"; // today (ET ~now)
const startMs = new Date(ANCHOR).getTime() - DAYS * 86400_000;
const SINCE = new Date(startMs).toISOString();

type Bucket = { count: number; cents: number };
const weekly = new Map<string, Bucket>();
let earliest: string | undefined;
let totalOpenPaid = 0;
let totalOpenPaidCents = 0;
const perLoc: Record<string, { count: number; cents: number }> = {};

function weekKey(iso: string): string {
  // ISO week-ish bucket: YYYY-MM-DD of the Sunday-anchored week start.
  const d = new Date(iso);
  const day = d.getUTCDay();
  const sunday = new Date(d.getTime() - day * 86400_000);
  return sunday.toISOString().slice(0, 10);
}

for (const [locId, locName] of Object.entries(LOCS)) {
  let cursor: string | undefined;
  do {
    const body: any = {
      location_ids: [locId],
      query: {
        filter: {
          state_filter: { states: ["OPEN"] },
          date_time_filter: { created_at: { start_at: SINCE, end_at: ANCHOR } },
        },
        sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
      },
      limit: 200,
    };
    if (cursor) body.cursor = cursor;
    const res = await fetch(`${BASE}/orders/search`, { method: "POST", headers: H, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (data.errors) {
      console.error(`${locName}: ${JSON.stringify(data.errors)}`);
      break;
    }
    for (const o of (data.orders ?? []) as any[]) {
      const total = o.total_money?.amount ?? 0;
      const due = o.net_amount_due_money?.amount ?? 0;
      if (total > 0 && due === 0) {
        totalOpenPaid++;
        totalOpenPaidCents += total;
        perLoc[locName] = perLoc[locName] ?? { count: 0, cents: 0 };
        perLoc[locName].count++;
        perLoc[locName].cents += total;
        const wk = weekKey(o.created_at);
        const b = weekly.get(wk) ?? { count: 0, cents: 0 };
        b.count++;
        b.cents += total;
        weekly.set(wk, b);
        if (!earliest || o.created_at < earliest) earliest = o.created_at;
      }
    }
    cursor = data.cursor;
  } while (cursor);
}

const D = (c: number) => `$${(c / 100).toFixed(2)}`;
console.log(`Scanned OPEN orders created since ${SINCE} (≈${DAYS}d) at ${Object.values(LOCS).join(" + ")}.\n`);
console.log(`PAID-IN-FULL but OPEN (total>0, due=$0): ${totalOpenPaid} orders, ${D(totalOpenPaidCents)}\n`);
console.log("By location:");
for (const [n, v] of Object.entries(perLoc)) console.log(`  ${n}: ${v.count} orders, ${D(v.cents)}`);
console.log(`\nEarliest such order: ${earliest ?? "none found"}`);
console.log("\nBy week (Sunday-anchored):");
for (const wk of [...weekly.keys()].sort()) {
  const b = weekly.get(wk)!;
  console.log(`  ${wk}:  ${String(b.count).padStart(4)} orders   ${D(b.cents)}`);
}
process.exit(0);
