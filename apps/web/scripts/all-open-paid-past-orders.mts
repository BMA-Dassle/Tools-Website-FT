/**
 * READ-ONLY: full list of paid-in-full, PAST-event, state=OPEN web day-of orders
 * (open/kbf/race/attraction; combos excluded — own settle flow). Writes a CSV and
 * prints per-month + per-day-of-week-ignored totals + grand total. This is the
 * close-out work-list; nothing is mutated here.
 *   node --env-file=apps/web/.env.local apps/web/scripts/all-open-paid-past-orders.mts [daysBack] > c:/tmp/open-paid-past-orders.csv
 *   (summary goes to stderr so stdout is clean CSV)
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
const TODAY = "2026-06-16";
const LOC: Record<string, string> = { TXBSQN0FEKQ11: "Fort Myers", PPTR5G2N0QXF7: "Naples", LAB52GY480CJF: "FastTrax" };

const rows = (await sql`
  SELECT id, product_kind, status, guest_name, center_code, square_dayof_order_id,
         to_char((booked_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date < ${TODAY}::date
    AND (booked_at AT TIME ZONE 'America/New_York')::date > (${TODAY}::date - ${DAYS}::int)
    AND product_kind IN ('open','kbf','race','attraction') AND combo_special_id IS NULL
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
  ORDER BY id
`) as any[];

const meta = new Map<string, { resId: number; guest: string; kind: string; loc: string; day: string }>();
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
      resId: r.id,
      guest: r.guest_name ?? "",
      kind: r.product_kind,
      loc: LOC[r.center_code] ?? r.center_code,
      day: String(r.day).slice(0, 10),
    });
    ids.push(id);
  }
}

const csv = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const D = (c: number) => (c / 100).toFixed(2);

console.log("res_id,order_id,kind,location,session_day,amount,guest"); // CSV header -> stdout
let count = 0;
let totalCents = 0;
const byMonth = new Map<string, { n: number; cents: number }>();
const byKind = new Map<string, { n: number; cents: number }>();

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
    if (o.state !== "OPEN" || due !== 0 || total <= 0) continue;
    const m = meta.get(o.id)!;
    count++;
    totalCents += total;
    console.log([m.resId, o.id, m.kind, csv(m.loc), m.day, D(total), csv(m.guest)].join(","));
    const mon = m.day.slice(0, 7);
    const bm = byMonth.get(mon) ?? { n: 0, cents: 0 };
    bm.n++;
    bm.cents += total;
    byMonth.set(mon, bm);
    const bk = byKind.get(m.kind) ?? { n: 0, cents: 0 };
    bk.n++;
    bk.cents += total;
    byKind.set(m.kind, bk);
  }
}

const e = (s: string) => process.stderr.write(s + "\n");
e(`\n──────── paid-but-OPEN past orders (close-out work-list) ────────`);
e(`Window: sessions before ${TODAY}, last ~${DAYS}d. Combos excluded.`);
e(`\nBy month (by session day):`);
for (const mon of [...byMonth.keys()].sort()) {
  const b = byMonth.get(mon)!;
  e(`  ${mon}:  ${String(b.n).padStart(4)} orders   $${D(b.cents)}`);
}
e(`\nBy kind:`);
for (const [k, b] of byKind) e(`  ${k.padEnd(10)}: ${String(b.n).padStart(4)} orders   $${D(b.cents)}`);
e(`\nGRAND TOTAL: ${count} orders   $${D(totalCents)}`);
process.exit(0);
