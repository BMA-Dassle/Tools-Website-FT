/** READ-ONLY: inspect the past combo BOWLING legs that are OPEN with $0 due, to
 * confirm they're paid-in-full (tenders cover total) and have no open fulfillment,
 * so an OPEN→COMPLETED transition is a safe no-charge state flip. */
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
const D = (c: number) => `$${((c || 0) / 100).toFixed(2)}`;

// Re-derive from DB so we never act on a stale list: past combo bowling legs, OPEN, $0 due.
const rows = (await sql`
  SELECT id, combo_special_id, product_kind, guest_name, status, center_code,
         square_dayof_order_id AS oid, square_gift_card_id AS gc,
         to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD HH24:MI') AS slot
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
    AND square_dayof_order_id IS NOT NULL
    AND product_kind IN ('open','kbf')
    AND booked_at < NOW() - INTERVAL '2 hours'
  ORDER BY booked_at, id
`) as any[];

for (const r of rows) {
  const oid = String(r.oid);
  const o = (await (await fetch(`${BASE}/orders/${oid}`, { headers: H })).json().catch(() => ({}))).order;
  if (!o) {
    console.log(`res#${r.id} ${oid}: FETCH-FAIL`);
    continue;
  }
  const total = o.total_money?.amount ?? 0;
  const due = o.net_amount_due_money?.amount ?? 0;
  if (o.state !== "OPEN") continue; // only the stuck-OPEN ones are interesting here
  const tenders = (o.tenders ?? []).map((t: any) => `${t.type}=${D(t.amount_money?.amount)}`).join(", ") || "(NONE)";
  const fulfillments = (o.fulfillments ?? []).map((f: any) => `${f.type}:${f.state}`).join(", ") || "(none)";
  const lineItems = (o.line_items ?? []).length;
  console.log(
    `res#${r.id} combo${r.combo_special_id} ${String(r.guest_name).slice(0, 18).padEnd(18)} slot=${r.slot} status=${r.status}`,
  );
  console.log(
    `   order ${oid}  state=${o.state}  v=${o.version}  loc=${o.location_id}  total=${D(total)} paid=${D(total - due)} DUE=${D(due)}  lineItems=${lineItems}`,
  );
  console.log(`   tenders: ${tenders}`);
  console.log(`   fulfillments: ${fulfillments}`);
  const safe = due === 0 && (o.fulfillments ?? []).every((f: any) => ["COMPLETED", "CANCELED", "CANCELLED"].includes(f.state) || !f.state);
  console.log(`   → ${due === 0 ? "PAID-IN-FULL" : "BALANCE DUE"}; ${safe ? "SAFE to complete" : "NEEDS REVIEW (open fulfillment or balance)"}`);
}
process.exit(0);
