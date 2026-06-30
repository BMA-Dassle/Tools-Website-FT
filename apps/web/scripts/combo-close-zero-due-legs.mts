/**
 * Close past combo BOWLING legs whose day-of Square order is stuck OPEN despite
 * being PAID IN FULL ($0 due, gift-card tender). These never flipped to COMPLETED
 * because their SHIPMENT fulfillment was left in PREPARED. NO charge is made — this
 * only advances the fulfillment PREPARED→COMPLETED and the order OPEN→COMPLETED.
 *
 * Hard guards (each order re-fetched fresh before acting):
 *   - product_kind IN ('open','kbf') AND combo_special_id IS NOT NULL
 *   - booked_at (the bowling slot) is in the past
 *   - order.state === 'OPEN'
 *   - net_amount_due === 0  (refuses to touch anything still owing — those are a
 *     different settle path; this script NEVER charges a card)
 *
 * DRY RUN by default. Pass --live to execute.
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
const LIVE = process.argv.includes("--live");
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const D = (c: number) => `$${((c || 0) / 100).toFixed(2)}`;
const TERMINAL_FULFILLMENT = new Set(["COMPLETED", "CANCELED", "CANCELLED"]);

const rows = (await sql`
  SELECT id, combo_special_id, product_kind, guest_name,
         square_dayof_order_id AS oid,
         to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD HH24:MI') AS slot
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
    AND square_dayof_order_id IS NOT NULL
    AND product_kind IN ('open','kbf')
    AND booked_at < NOW() - INTERVAL '2 hours'
  ORDER BY booked_at, id
`) as any[];

console.log(LIVE ? "=== LIVE close ===\n" : "=== DRY RUN (pass --live to execute) ===\n");
let acted = 0,
  skipped = 0,
  failed = 0;

for (const r of rows) {
  const oid = String(r.oid);
  const label = `res#${r.id} ${String(r.guest_name).slice(0, 18).padEnd(18)} ${r.slot} ${oid.slice(0, 8)}`;
  const o = (await (await fetch(`${BASE}/orders/${oid}`, { headers: H })).json().catch(() => ({}))).order;
  if (!o) {
    console.log(`FETCH-FAIL ${label}`);
    failed++;
    continue;
  }
  const due = o.net_amount_due_money?.amount ?? 0;
  if (o.state !== "OPEN") {
    skipped++;
    continue; // already closed/other — silent
  }
  if (due !== 0) {
    console.log(`SKIP-DUE   ${label} state=OPEN DUE=${D(due)} — needs settlement, not this script`);
    skipped++;
    continue;
  }

  // Build fulfillment updates: any non-terminal fulfillment → COMPLETED.
  const fulfillments = (o.fulfillments ?? [])
    .filter((f: any) => f.uid && !TERMINAL_FULFILLMENT.has(f.state))
    .map((f: any) => ({ uid: f.uid, state: "COMPLETED" }));
  const fDesc = (o.fulfillments ?? []).map((f: any) => `${f.type}:${f.state}`).join(",") || "(none)";

  console.log(`CLOSE      ${label} total=${D(o.total_money?.amount ?? 0)} paid-in-full  fulfillments[${fDesc}] → COMPLETED  v=${o.version}`);
  if (!LIVE) {
    acted++;
    continue;
  }

  const body: any = { order: { location_id: o.location_id, version: o.version, state: "COMPLETED" } };
  if (fulfillments.length) body.order.fulfillments = fulfillments;
  const res = await fetch(`${BASE}/orders/${oid}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) {
    console.log(`  ‼ FAILED: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
    failed++;
    continue;
  }
  console.log(`  OK → state=${j.order?.state}`);
  acted++;
}

console.log(`\n${LIVE ? "Closed" : "Would close"}: ${acted}   skipped: ${skipped}   failed: ${failed}`);
process.exit(0);
