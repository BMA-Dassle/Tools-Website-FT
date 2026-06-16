/** Rebuild a group-function quote's stale day-of Square order to match the current
 *  contract line items + tax. General version of the H1174 fix.
 *
 *  Usage:  tsx scripts/gf-rebuild-dayof.mts <quoteId> [--commit]
 *  Default = PREVIEW. --commit creates the new order, repoints square_dayof_order_id,
 *  cancels the old order, and audit-logs. Does NOT touch approval_required/holds.
 *  Aborts if the new Square total differs from total_cents by > 50c.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const QID = Number(process.argv[2]);
const COMMIT = process.argv.includes("--commit");
if (!QID) throw new Error("usage: gf-rebuild-dayof.mts <quoteId> [--commit]");

const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const d = (c: number) => `$${(c / 100).toFixed(2)}`;
const TOL = 50;

const { createDayofOrder } = await import("@/lib/group-function-dayof");
const { randomBytes } = await import("node:crypto");
const { sql } = await import("@/lib/db");
const q = sql();

const rows = (await q`SELECT * FROM group_function_quotes WHERE id = ${QID}`) as Array<Record<string, unknown>>;
if (!rows.length) throw new Error(`no quote #${QID}`);
const quote = rows[0] as never as import("@/lib/group-function-db").GroupFunctionQuote;

console.log(`MODE: ${COMMIT ? "COMMIT" : "PREVIEW"}`);
console.log(`#${quote.id} ${quote.event_number} "${quote.event_name}" ${quote.center_code} ${quote.status}`);
console.log(`contract total=${d(quote.total_cents)}  collected=${d(quote.collected_cents)}  balance=${d(quote.balance_cents)}`);
console.log(`current day-of order: ${quote.square_dayof_order_id}`);

let oldTotal = -1;
if (quote.square_dayof_order_id) {
  const j = await (await fetch(`${BASE}/orders/${quote.square_dayof_order_id}`, { headers: H })).json();
  oldTotal = j.order?.total_money?.amount ?? -1;
  console.log(`current day-of total = ${oldTotal < 0 ? "?" : d(oldTotal)}  state=${j.order?.state}`);
}
const items = quote.line_items as Array<{ name: string; total: number }>;
const expected = Math.round(items.reduce((s, p) => s + (p.total || 0), 0) * 100) + quote.tax_cents;
console.log(`\nnew day-of total (line items + tax ${d(quote.tax_cents)}) = ${d(expected)}`);
for (const li of items) console.log(`   • "${li.name}" ${d(Math.round((li.total || 0) * 100))}`);

if (!COMMIT) {
  console.log(`\nPREVIEW only — re-run with --commit.`);
  process.exit(0);
}

const baseKey = randomBytes(8).toString("hex");
const dayof = await createDayofOrder(quote, baseKey);
if (!dayof) throw new Error("createDayofOrder failed — no changes");
console.log(`\nnew order ${dayof.id} total=${d(dayof.totalCents)}`);
if (Math.abs(dayof.totalCents - quote.total_cents) > TOL) {
  console.error(`ABORT: new total ${d(dayof.totalCents)} != contract ${d(quote.total_cents)} (>${TOL}c). Cancelling new order.`);
  const cur = await (await fetch(`${BASE}/orders/${dayof.id}`, { headers: H })).json();
  await fetch(`${BASE}/orders/${dayof.id}`, { method: "PUT", headers: H, body: JSON.stringify({ order: { location_id: quote.square_location_id, version: cur.order?.version, state: "CANCELED" } }) });
  process.exit(1);
}
const oldOrderId = quote.square_dayof_order_id;
await q`UPDATE group_function_quotes SET square_dayof_order_id = ${dayof.id}, updated_at = NOW() WHERE id = ${quote.id}`;
console.log(`repointed → ${dayof.id}`);
if (oldOrderId) {
  try {
    const cur = await (await fetch(`${BASE}/orders/${oldOrderId}`, { headers: H })).json();
    const res = await fetch(`${BASE}/orders/${oldOrderId}`, { method: "PUT", headers: H, body: JSON.stringify({ order: { location_id: quote.square_location_id, version: cur.order?.version, state: "CANCELED" } }) });
    console.log(`old order ${oldOrderId} cancel: HTTP ${res.status}`);
  } catch (e) { console.warn("old cancel failed (non-fatal):", e); }
}
await q`INSERT INTO contract_audit_log (quote_id, event, actor_email, metadata)
  VALUES (${quote.id}, 'dayof_order_rebuilt', ${process.env.USER_EMAIL ?? "eric@headpinz.com"},
    ${JSON.stringify({ oldOrderId, oldTotal, newOrderId: dayof.id, newTotalCents: dayof.totalCents, tool: "gf-rebuild-dayof.mts" })})`;
console.log(`DONE #${quote.id}: day-of order now ${d(dayof.totalCents)} = contract.`);
process.exit(0);
