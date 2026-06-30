/**
 * READ-ONLY: pinpoint the first days our web day-of orders were left paid-but-OPEN.
 * Lists the earliest such orders with exact event/booked dates + a per-day count.
 *   node --env-file=apps/web/.env.local apps/web/scripts/open-paid-start-day.mts [daysBack]
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
const DAYS = Number(process.argv[2] ?? "200");
const ANCHOR = "2026-06-16";

const rows = (await sql`
  SELECT id, booked_at, square_dayof_order_id, product_kind, status, guest_name
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date > (${ANCHOR}::date - ${DAYS}::int)
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
  ORDER BY booked_at
`) as any[];

const meta = new Map<string, { booked: string; resId: number; guest: string; kind: string }>();
const ids: string[] = [];
for (const r of rows) {
  let id: string = r.square_dayof_order_id;
  try {
    const p = JSON.parse(r.square_dayof_order_id);
    if (Array.isArray(p) && p.length) id = p[0];
  } catch {
    /* bare */
  }
  if (id && !meta.has(id)) {
    meta.set(id, {
      booked: r.booked_at instanceof Date ? r.booked_at.toISOString() : String(r.booked_at),
      resId: r.id,
      guest: r.guest_name,
      kind: r.product_kind,
    });
    ids.push(id);
  }
}

type Rec = { orderDay: string; bookedDay: string; resId: number; guest: string; kind: string; cents: number };
const openPaid: Rec[] = [];
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const res = await fetch(`${BASE}/orders/batch-retrieve`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ order_ids: chunk }),
  });
  const data = await res.json().catch(() => ({}));
  for (const o of (data.orders ?? []) as any[]) {
    const total = o.total_money?.amount ?? 0;
    const due = o.net_amount_due_money?.amount ?? 0;
    if (o.state === "OPEN" && total > 0 && due === 0) {
      const m = meta.get(o.id)!;
      openPaid.push({
        orderDay: (o.created_at ?? "").slice(0, 10),
        bookedDay: m.booked.slice(0, 10),
        resId: m.resId,
        guest: m.guest,
        kind: m.kind,
        cents: total,
      });
    }
  }
}

openPaid.sort((a, b) => (a.orderDay < b.orderDay ? -1 : a.orderDay > b.orderDay ? 1 : a.resId - b.resId));
const D = (c: number) => `$${(c / 100).toFixed(2)}`;

console.log(`Earliest 20 paid-but-OPEN web day-of orders (by Square order created date):\n`);
for (const r of openPaid.slice(0, 20)) {
  console.log(`  ${r.orderDay}  res#${r.resId}  ${r.kind.padEnd(10)} ${D(r.cents).padStart(9)}  ${r.guest}`);
}

const perDay = new Map<string, { n: number; cents: number }>();
for (const r of openPaid) {
  const b = perDay.get(r.orderDay) ?? { n: 0, cents: 0 };
  b.n++;
  b.cents += r.cents;
  perDay.set(r.orderDay, b);
}
console.log(`\nPer-day counts (first 21 days with any):`);
for (const day of [...perDay.keys()].sort().slice(0, 21)) {
  const b = perDay.get(day)!;
  console.log(`  ${day}: ${String(b.n).padStart(4)} orders  ${D(b.cents)}`);
}
console.log(`\nTotal paid-but-OPEN: ${openPaid.length}`);
process.exit(0);
