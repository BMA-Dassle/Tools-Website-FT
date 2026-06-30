/**
 * READ-ONLY closure audit: for every group-function reservation whose EVENT DATE
 * is in the PAST (before today ET) and that has a day-of Square order, fetch the
 * order from Square and report whether it actually CLOSED (state=COMPLETED).
 *
 * A past event's day-of order should be COMPLETED. Anything still OPEN/DRAFT is a
 * "never closed" case:
 *   - OPEN, due=0, total>0  → tendered/paid but order left OPEN (H2821 class)
 *   - OPEN, due>0           → balance never charged at the event (no settle / no-show)
 *   - DRAFT                 → never finalized
 *
 * Usage: node --env-file=apps/web/.env.local apps/web/scripts/gf-past-dayof-closure-audit.mts [daysBack]
 *   daysBack defaults to 1000 (effectively "all previous").
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
const DAYS = Number(process.argv[2] ?? "1000");
const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD

const D = (c: number) => `$${(c / 100).toFixed(2)}`;
const ymd = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

const rows = (await sql`
  SELECT id, event_name, event_number, center_code, event_date, status,
         total_cents, deposit_due_cents, balance_cents,
         deposit_paid_at, balance_paid_at, square_dayof_order_id
  FROM group_function_quotes
  WHERE event_date::date < ${todayET}::date
    AND event_date::date >= (${todayET}::date - ${DAYS}::int)
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
    AND status NOT IN ('cancelled','denied')
  ORDER BY event_date
`) as any[];

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

async function getOrder(id: string) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  const o = (await res.json().catch(() => ({}))).order;
  return o ? { state: o.state as string, total: o.total_money?.amount ?? 0, due: o.net_amount_due_money?.amount ?? 0 } : null;
}

const byState: Record<string, number> = {};
const notClosed: string[] = [];
let totalOrders = 0;
let closed = 0;
let canceled = 0;
let openPaid = 0,
  openPaidCents = 0,
  openDue = 0,
  openDueCents = 0,
  draft = 0,
  fetchFail = 0;

console.log(`Past group-function reservations w/ a day-of order (event < ${todayET}, back ${DAYS}d): ${rows.length}\n`);

for (const r of rows) {
  const ed = ymd(r.event_date);
  const fullyPaid = r.balance_paid_at != null || (r.balance_cents ?? 0) === 0;
  for (const id of orderIds(r.square_dayof_order_id)) {
    totalOrders++;
    const o = await getOrder(id);
    if (!o) {
      byState["FETCH_FAIL"] = (byState["FETCH_FAIL"] ?? 0) + 1;
      fetchFail++;
      notClosed.push(`  FETCH-FAIL ${ed}  gf#${r.id} ${r.center_code} "${r.event_name}" #${r.event_number ?? "?"}  order=${id}`);
      continue;
    }
    byState[o.state] = (byState[o.state] ?? 0) + 1;
    if (o.state === "COMPLETED") {
      closed++;
    } else if (o.state === "CANCELED" || o.state === "CANCELLED") {
      canceled++;
    } else if (o.state === "OPEN" && o.due === 0 && o.total > 0) {
      openPaid++;
      openPaidCents += o.total;
      notClosed.push(
        `  OPEN-PAID  ${ed}  gf#${r.id} ${r.center_code} "${r.event_name}" #${r.event_number ?? "?"}  ${D(o.total)} due ${D(o.due)}  status=${r.status} prepaid=${fullyPaid}  order=${id}`,
      );
    } else if (o.state === "OPEN") {
      openDue++;
      openDueCents += o.due;
      notClosed.push(
        `  OPEN-DUE   ${ed}  gf#${r.id} ${r.center_code} "${r.event_name}" #${r.event_number ?? "?"}  total ${D(o.total)} DUE ${D(o.due)}  status=${r.status} prepaid=${fullyPaid}  order=${id}`,
      );
    } else if (o.state === "DRAFT") {
      draft++;
      notClosed.push(`  DRAFT      ${ed}  gf#${r.id} ${r.center_code} "${r.event_name}" #${r.event_number ?? "?"}  ${D(o.total)}  status=${r.status}  order=${id}`);
    }
  }
}

console.log("Day-of order states (past events only):");
for (const [s, n] of Object.entries(byState).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);
console.log(`\nTotal day-of orders checked: ${totalOrders}`);
console.log(`  CLOSED (COMPLETED):              ${closed}`);
console.log(`  CANCELED:                        ${canceled}`);
console.log(`  NOT CLOSED — OPEN, paid (due=0): ${openPaid}  (${D(openPaidCents)} tendered, order still open)`);
console.log(`  NOT CLOSED — OPEN, balance due:  ${openDue}  (${D(openDueCents)} never charged)`);
console.log(`  NOT CLOSED — DRAFT:              ${draft}`);
console.log(`  FETCH-FAIL:                      ${fetchFail}`);
if (notClosed.length) {
  console.log(`\n=== ${notClosed.length} past day-of orders that did NOT close ===`);
  for (const l of notClosed.sort()) console.log(l);
} else {
  console.log(`\n✅ Every past group-function day-of order is CLOSED/CANCELED. Nothing stuck open.`);
}
process.exit(0);
