/** Remediate H1174 (quote #150): rebuild the stale day-of Square order to match
 *  the current 2-party contract ($850.86), tidy deposit_due_cents, and release the
 *  balance-charge hold so the correct $638.14 auto-charges and loads the gift card
 *  to a matching $850.86.
 *
 *  Default = PREVIEW (no writes). Pass --commit to execute.
 *
 *  Steps on --commit:
 *    1. createDayofOrder(quote) → new OPEN order from current 2-party line items.
 *    2. ABORT unless Square's total is within 50c of the contract total ($850.86).
 *    3. Repoint square_dayof_order_id → new order; set deposit_due_cents = 50% ($425.43).
 *    4. CANCEL the old $425.43 day-of order (non-fatal if it fails).
 *    5. Release the hold (approval_required = FALSE) so the 72h cron charges $638.14.
 *    6. Audit log.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const COMMIT = process.argv.includes("--commit");
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
  "Content-Type": "application/json",
};
const d = (c: number) => `$${(c / 100).toFixed(2)}`;
const money = (m: unknown) => (m as { amount?: number })?.amount ?? 0;
const TOL = 50;

const { getGfQuoteByShortId } = await import("@/lib/group-function-db");
const { createDayofOrder } = await import("@/lib/group-function-dayof");
const { randomBytes } = await import("node:crypto");
const { sql } = await import("@/lib/db");
const q = sql();

const quote = await getGfQuoteByShortId("3a6497bb");
if (!quote) throw new Error("quote not found");

console.log(`MODE: ${COMMIT ? "COMMIT" : "PREVIEW (no writes)"}`);
console.log(`quote #${quote.id}  status=${quote.status}  approval_required(hold)=${quote.approval_required}`);
console.log(`total=${d(quote.total_cents)}  collected=${d(quote.collected_cents)}  balance(to charge)=${d(quote.balance_cents)}  deposit_due=${d(quote.deposit_due_cents)}`);
console.log(`current (stale) day-of order: ${quote.square_dayof_order_id}`);

// Expected day-of total from current line items + tax.
const items = quote.line_items as Array<{ name: string; total: number }>;
const lineSum = Math.round(items.reduce((s, p) => s + (p.total || 0), 0) * 100);
const expected = lineSum + quote.tax_cents;
console.log(`\nexpected new day-of total = line items ${d(lineSum)} + tax ${d(quote.tax_cents)} = ${d(expected)}`);
for (const li of items) console.log(`   • "${li.name}" ${d(Math.round((li.total || 0) * 100))}`);

if (!COMMIT) {
  console.log(`\nPREVIEW only. Re-run with --commit to: create the $850.86 day-of order, repoint, cancel the old, release the hold.`);
  process.exit(0);
}

// ── COMMIT ──
const baseKey = randomBytes(8).toString("hex");
const dayof = await createDayofOrder(quote, baseKey);
if (!dayof) throw new Error("createDayofOrder failed — aborting, no changes made");
console.log(`\nnew day-of order created: ${dayof.id}  total=${d(dayof.totalCents)}`);

if (Math.abs(dayof.totalCents - quote.total_cents) > TOL) {
  console.error(`ABORT: new order total ${d(dayof.totalCents)} differs from contract total ${d(quote.total_cents)} by > ${TOL}c.`);
  console.error(`Cancelling the just-created order to avoid an orphan…`);
  const cur = await (await fetch(`${BASE}/orders/${dayof.id}`, { headers: H })).json();
  await fetch(`${BASE}/orders/${dayof.id}`, {
    method: "PUT", headers: H,
    body: JSON.stringify({ order: { location_id: quote.square_location_id, version: cur.order?.version, state: "CANCELED" } }),
  });
  process.exit(1);
}

const oldOrderId = quote.square_dayof_order_id;
const newDeposit = Math.round(quote.total_cents / 2);

await q`UPDATE group_function_quotes SET
  square_dayof_order_id = ${dayof.id},
  deposit_due_cents = ${newDeposit},
  approval_required = FALSE,
  updated_at = NOW()
WHERE id = ${quote.id}`;
console.log(`repointed day-of order → ${dayof.id}; deposit_due → ${d(newDeposit)}; hold RELEASED (approval_required=FALSE).`);

// Cancel the old stale order (non-fatal).
if (oldOrderId) {
  try {
    const cur = await (await fetch(`${BASE}/orders/${oldOrderId}`, { headers: H })).json();
    const res = await fetch(`${BASE}/orders/${oldOrderId}`, {
      method: "PUT", headers: H,
      body: JSON.stringify({ order: { location_id: quote.square_location_id, version: cur.order?.version, state: "CANCELED" } }),
    });
    console.log(`old order ${oldOrderId} cancel: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`old order cancel failed (non-fatal):`, e);
  }
}

await q`INSERT INTO contract_audit_log (quote_id, event, actor_email, metadata)
  VALUES (${quote.id}, 'dayof_order_rebuilt', ${process.env.USER_EMAIL ?? "eric@headpinz.com"},
    ${JSON.stringify({ oldOrderId, newOrderId: dayof.id, newTotalCents: dayof.totalCents, depositDueCents: newDeposit, holdReleased: true, tool: "h1174-remediate.mts" })})`;
console.log(`audit logged: dayof_order_rebuilt. DONE — balance ${d(quote.balance_cents)} will auto-charge on the next 72h cron run and load the gift card to ${d(quote.total_cents)}.`);
process.exit(0);
