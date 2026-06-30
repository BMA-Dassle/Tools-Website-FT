/**
 * READ-ONLY: Are group-function (pre-paid group event) day-of Square orders also
 * left OPEN once paid? Scans group_function_quotes with a day-of order, retrieves
 * each order from Square, buckets by state + paid status.
 *   node --env-file=apps/web/.env.local apps/web/scripts/gf-dayof-order-states.mts [daysBack]
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
  SELECT id, event_name, event_number, event_date, status, total_cents,
         deposit_due_cents, balance_cents, deposit_paid_at, balance_paid_at,
         square_dayof_order_id
  FROM group_function_quotes
  WHERE event_date::date > (${ANCHOR}::date - ${DAYS}::int)
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
    AND status NOT IN ('cancelled','denied')
  ORDER BY event_date
`) as any[];

const D = (c: number) => `$${(c / 100).toFixed(2)}`;
function* orderIds(raw: string): Generator<string> {
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) {
      for (const x of p) if (x) yield String(x);
      return;
    }
  } catch {
    /* bare */
  }
  yield raw;
}

async function getOrder(id: string) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  const o = (await res.json().catch(() => ({}))).order;
  return o ? { state: o.state as string, total: o.total_money?.amount ?? 0, due: o.net_amount_due_money?.amount ?? 0 } : null;
}

const byState: Record<string, number> = {};
let openPaid = 0,
  openPaidCents = 0,
  openUnpaid = 0,
  completed = 0;
let earliestOpenPaid: string | undefined;
const openPaidList: string[] = [];

console.log(`Group-function quotes with a day-of order, events in last ~${DAYS}d: ${rows.length}\n`);

for (const r of rows) {
  const fullyPaid = r.balance_paid_at != null || (r.balance_cents ?? 0) === 0;
  for (const id of orderIds(r.square_dayof_order_id)) {
    const o = await getOrder(id);
    if (!o) {
      byState["FETCH_FAIL"] = (byState["FETCH_FAIL"] ?? 0) + 1;
      continue;
    }
    byState[o.state] = (byState[o.state] ?? 0) + 1;
    if (o.state === "COMPLETED") completed++;
    else if (o.state === "OPEN" && o.total > 0 && o.due === 0) {
      openPaid++;
      openPaidCents += o.total;
      const ed = (r.event_date instanceof Date ? r.event_date.toISOString() : String(r.event_date)).slice(0, 10);
      if (!earliestOpenPaid || ed < earliestOpenPaid) earliestOpenPaid = ed;
      openPaidList.push(
        `  ${ed}  gf#${r.id} ${r.event_name} #${r.event_number ?? "?"}  ${D(o.total)}  prepaid=${fullyPaid}  order=${id}`,
      );
    } else if (o.state === "OPEN") openUnpaid++;
  }
}

console.log("Day-of order states:");
for (const [s, n] of Object.entries(byState).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);
console.log(`\nPAID-IN-FULL but OPEN: ${openPaid} (${D(openPaidCents)})`);
console.log(`OPEN with balance still due: ${openUnpaid}`);
console.log(`COMPLETED: ${completed}`);
console.log(`Earliest GF paid-but-OPEN (by event date): ${earliestOpenPaid ?? "none"}`);
if (openPaidList.length) {
  console.log(`\nPaid-but-OPEN group events:`);
  for (const l of openPaidList.sort()) console.log(l);
}
process.exit(0);
