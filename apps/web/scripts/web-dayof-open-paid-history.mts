/**
 * READ-ONLY: For OUR website-booked bowling day-of orders only, how long have
 * paid-in-full orders been left OPEN vs COMPLETED? Pulls day-of order ids from
 * Neon over a window, BatchRetrieves them from Square, buckets by week.
 *   node --env-file=apps/web/.env.local apps/web/scripts/web-dayof-open-paid-history.mts [daysBack]
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
const DAYS = Number(process.argv[2] ?? "150");
const ANCHOR = "2026-06-16";

const rows = (await sql`
  SELECT id, booked_at, square_dayof_order_id, product_kind, status, total_cents
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date > (${ANCHOR}::date - ${DAYS}::int)
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
  ORDER BY booked_at
`) as any[];

// Map order id -> reservation booked_at (for week bucketing).
const idToBooked = new Map<string, string>();
const ids: string[] = [];
for (const r of rows) {
  let id: string = r.square_dayof_order_id;
  try {
    const p = JSON.parse(r.square_dayof_order_id);
    if (Array.isArray(p) && p.length) id = p[0];
  } catch {
    /* bare */
  }
  if (id && !idToBooked.has(id)) {
    idToBooked.set(id, r.booked_at instanceof Date ? r.booked_at.toISOString() : String(r.booked_at));
    ids.push(id);
  }
}

const D = (c: number) => `$${(c / 100).toFixed(2)}`;
function weekKey(iso: string): string {
  const d = new Date(iso);
  const sunday = new Date(d.getTime() - d.getUTCDay() * 86400_000);
  return sunday.toISOString().slice(0, 10);
}

type WB = { openPaid: number; openPaidCents: number; completed: number; canceled: number; openUnpaid: number };
const weekly = new Map<string, WB>();
const blank = (): WB => ({ openPaid: 0, openPaidCents: 0, completed: 0, canceled: 0, openUnpaid: 0 });
let earliest: string | undefined;
let totals = blank();

for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const res = await fetch(`${BASE}/orders/batch-retrieve`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ order_ids: chunk }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.errors) {
    console.error(JSON.stringify(data.errors));
  }
  for (const o of (data.orders ?? []) as any[]) {
    const booked = idToBooked.get(o.id) ?? o.created_at;
    const wk = weekKey(booked);
    const b = weekly.get(wk) ?? blank();
    const total = o.total_money?.amount ?? 0;
    const due = o.net_amount_due_money?.amount ?? 0;
    if (o.state === "COMPLETED") {
      b.completed++;
      totals.completed++;
    } else if (o.state === "CANCELED") {
      b.canceled++;
      totals.canceled++;
    } else if (o.state === "OPEN" && total > 0 && due === 0) {
      b.openPaid++;
      b.openPaidCents += total;
      totals.openPaid++;
      totals.openPaidCents += total;
      if (!earliest || booked < earliest) earliest = booked;
    } else if (o.state === "OPEN") {
      b.openUnpaid++;
      totals.openUnpaid++;
    }
    weekly.set(wk, b);
  }
}

console.log(`Our web day-of orders booked in last ~${DAYS}d: ${ids.length} unique orders.\n`);
console.log(`PAID-IN-FULL but OPEN: ${totals.openPaid} (${D(totals.openPaidCents)})`);
console.log(`COMPLETED: ${totals.completed}   CANCELED: ${totals.canceled}   OPEN-unpaid/other: ${totals.openUnpaid}`);
console.log(`\nEarliest paid-but-OPEN web order (by booked_at): ${earliest ?? "none"}\n`);
console.log("By week (Sun-anchored):  openPaid / completed / canceled / openUnpaid");
for (const wk of [...weekly.keys()].sort()) {
  const b = weekly.get(wk)!;
  console.log(
    `  ${wk}:  ${String(b.openPaid).padStart(4)} (${D(b.openPaidCents).padStart(10)})  | comp ${String(b.completed).padStart(3)} | canc ${String(b.canceled).padStart(3)} | openUnpaid ${b.openUnpaid}`,
  );
}
process.exit(0);
