/**
 * READ-ONLY: Cross-reference the orders the portal closed on 7/8-7/9
 * (C:\Work\VIP-Orders-Closed-By-Portal.csv) against Neon to explain WHY each
 * was still OPEN — which table/row it belongs to, product kind, combo flag,
 * status, checkin_method, and whether our close crons would ever have touched it.
 *   npx tsx apps/web/scripts/portal-closed-orders-xref.mts
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

// -- parse the portal CSV --------------------------------------------------
const csvPath = "C:/Work/VIP-Orders-Closed-By-Portal.csv";
const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
function parseLine(l: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) {
      if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
type CsvRow = { loc: string; orderId: string; orderDate: string; source: string; items: string; total: string; pay: string; closedAt: string };
const rows: CsvRow[] = lines.slice(1).map((l) => {
  const c = parseLine(l);
  return { loc: c[0], orderId: c[1], orderDate: c[2], source: c[3], items: c[5], total: c[9], pay: c[10], closedAt: c[11] };
});
console.log(`Portal-closed orders in CSV: ${rows.length}\n`);

// -- look up each order id across our tables --------------------------------
const ids = rows.map((r) => r.orderId);
const pats = ids.map((id) => `%${id}%`);

const br = (await sql`
  SELECT id, product_kind, combo_special_id, status, checkin_method, guest_name,
         square_dayof_order_id, square_deposit_order_id, dayof_order_completed_at,
         to_char((booked_at AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD HH24:MI') AS day
  FROM bowling_reservations
  WHERE square_dayof_order_id LIKE ANY(${pats}) OR square_deposit_order_id LIKE ANY(${pats})
`) as any[];

const gf = (await sql`
  SELECT id, event_name, event_number, status, event_date,
         square_dayof_order_id, square_deposit_order_id, square_balance_order_id, square_settled_order_id
  FROM group_function_quotes
  WHERE square_dayof_order_id LIKE ANY(${pats}) OR square_deposit_order_id LIKE ANY(${pats})
     OR square_balance_order_id LIKE ANY(${pats}) OR square_settled_order_id LIKE ANY(${pats})
`) as any[];

type Match = { table: string; role: string; desc: string };
const byOrder = new Map<string, Match[]>();
function tag(id: string, m: Match) {
  const a = byOrder.get(id) ?? [];
  a.push(m);
  byOrder.set(id, a);
}
for (const r of br) {
  for (const id of ids) {
    const inDayof = (r.square_dayof_order_id ?? "").includes(id);
    const inDep = (r.square_deposit_order_id ?? "").includes(id);
    if (!inDayof && !inDep) continue;
    tag(id, {
      table: "bowling_reservations",
      role: inDayof ? "dayof" : "deposit",
      desc: `res#${r.id} kind=${r.product_kind} combo=${r.combo_special_id ?? "-"} status=${r.status} checkin=${r.checkin_method ?? "NULL"} completed_at=${r.dayof_order_completed_at ? "set" : "NULL"} ${r.day} ${r.guest_name ?? ""}`,
    });
  }
}
for (const r of gf) {
  for (const id of ids) {
    const roles: string[] = [];
    if ((r.square_dayof_order_id ?? "").includes(id)) roles.push("dayof");
    if ((r.square_deposit_order_id ?? "").includes(id)) roles.push("deposit");
    if ((r.square_balance_order_id ?? "").includes(id)) roles.push("balance");
    if ((r.square_settled_order_id ?? "").includes(id)) roles.push("settled");
    if (!roles.length) continue;
    tag(id, {
      table: "group_function_quotes",
      role: roles.join("+"),
      desc: `gf#${r.id} "${r.event_name}" #${r.event_number ?? "?"} status=${r.status} event=${String(r.event_date).slice(0, 10)}`,
    });
  }
}

// -- report ------------------------------------------------------------------
const buckets = new Map<string, CsvRow[]>();
for (const row of rows) {
  const ms = byOrder.get(row.orderId);
  let bucket: string;
  if (!ms) bucket = "NOT IN NEON";
  else {
    const m = ms[0];
    if (m.table === "group_function_quotes") bucket = `GF ${m.role}`;
    else if (m.role === "deposit") bucket = "BR deposit order";
    else if (m.desc.includes("combo=-")) bucket = `BR dayof (non-combo)`;
    else bucket = "BR dayof COMBO leg";
  }
  const a = buckets.get(bucket) ?? [];
  a.push(row);
  buckets.set(bucket, a);
}

for (const [bucket, list] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n════ ${bucket} — ${list.length} orders ════`);
  for (const row of list) {
    const ms = byOrder.get(row.orderId);
    console.log(`  ${row.orderDate}  ${row.loc.slice(0, 4)}  $${row.total}  ${row.pay}  ${row.orderId}`);
    console.log(`      items: ${row.items.slice(0, 110)}`);
    for (const m of ms ?? []) console.log(`      -> [${m.table}.${m.role}] ${m.desc}`);
  }
}
process.exit(0);
