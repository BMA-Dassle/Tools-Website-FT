/**
 * Does every group-function contract actually BILL the tax its own line items imply?
 *
 * Two different failures, and only the second one costs money:
 *   MISRECORDED — tax was billed and collected, but the Square day-of order books it in
 *                 the wrong slot, so `total_tax_money` reads $0. Guest paid correctly.
 *   NOT BILLED  — the contract's stored `tax_cents` is 0 (or short) while its line items
 *                 carry non-zero tax rates, so the guest was never charged the tax at all.
 *                 This is real money we did not collect.
 *
 * Run from apps/web. READ-ONLY.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const $ = (c: number) => `$${(c / 100).toFixed(2)}`;

const rows = (await sql`
  select event_number, event_date, center_code, status, is_tax_exempt, tax_cents,
         total_cents, line_items, square_dayof_order_id, created_at
  from group_function_quotes
  where line_items is not null
  order by event_date desc
`) as any[];

type Row = { label: string; shortfall: number; stored: number; implied: number; future: boolean };
const notBilled: Row[] = [];
const exemptButTaxed: string[] = [];
let clean = 0;

const now = new Date();
for (const q of rows) {
  const items = (q.line_items as any[]).filter((i) => i && i.total);
  if (!items.length) continue;

  // What tax do this contract's own line items imply? (group-function-pricing.taxCents)
  const implied = Math.round(items.reduce((s, i) => s + (i.tax || 0) * (i.total || 0), 0) * 100);
  const stored = q.tax_cents as number;
  const future = new Date(q.event_date) > now;
  const label =
    `${String(q.event_number).padEnd(7)} ${String(new Date(q.event_date).toISOString()).slice(0, 10)} ` +
    `${String(q.center_code).padEnd(11)} ${String(q.status).padEnd(16)}`;

  if (q.is_tax_exempt) {
    // A tax-exempt event should imply nothing — if its lines carry rates, the exemption is
    // doing the work silently and the contract total is the only thing saying so.
    if (implied > 0 && stored === 0)
      exemptButTaxed.push(`${label} lines imply ${$(implied)}, exempt so billed $0`);
    else clean++;
    continue;
  }

  const shortfall = implied - stored;
  if (shortfall > 2) {
    notBilled.push({ label, shortfall, stored, implied, future });
  } else {
    clean++;
  }
}

console.log(`scanned ${rows.length} contracts\n`);
console.log(`=== TAX NEVER BILLED TO THE GUEST: ${notBilled.length} events ===`);
notBilled.sort((a, b) => b.shortfall - a.shortfall);
for (const r of notBilled)
  console.log(
    `  ${r.label} billed ${$(r.stored).padStart(9)}  should be ${$(r.implied).padStart(9)}  ` +
      `SHORT ${$(r.shortfall).padStart(9)}${r.future ? "   FUTURE — still collectable" : ""}`,
  );
const total = notBilled.reduce((s, r) => s + r.shortfall, 0);
const futureTotal = notBilled.filter((r) => r.future).reduce((s, r) => s + r.shortfall, 0);
console.log(
  `\n  uncollected tax: ${$(total)} total, of which ${$(futureTotal)} is on FUTURE events ` +
    `(${notBilled.filter((r) => r.future).length}) and still collectable`,
);

console.log(`\n=== tax-exempt events whose lines carry rates: ${exemptButTaxed.length} ===`);
for (const e of exemptButTaxed.slice(0, 10)) console.log(`  ${e}`);
if (exemptButTaxed.length > 10) console.log(`  … +${exemptButTaxed.length - 10} more`);

console.log(`\n${clean} contracts bill exactly the tax their line items imply.`);
if (notBilled.length) process.exitCode = 1;
