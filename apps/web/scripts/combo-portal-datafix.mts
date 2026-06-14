/**
 * Two combo-portal data fixes (READ-ONLY unless --apply):
 *   1) Un-tag backfill false positives: rows the backfill marked combo_special_id
 *      that are NOT VIP combos (a regular unified-cart race+bowling booking
 *      shares one day-of order too). Identified by Square line items lacking the
 *      combo signature (Ultimate Qualifier / Starter+Intermediate / VIP Bowling).
 *   2) Correct stale total_cents/deposit_cents on the 4 split-remediated combos:
 *      the remediation repointed the day-of orders but left both legs carrying
 *      the full combo total. Each leg should carry ITS day-of order's total so
 *      the portal (which now sums distinct day-of orders) shows the right amount.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const APPLY = process.argv.includes("--apply");
const { sql } = await import("@/lib/db");
const q = sql();

// (1) false positives — the 3 Eric Osborn Jun-05 carts (Karting + Midnight Madness),
//     confirmed non-combo by combo-lineitem-audit.mts.
const UNTAG_ROW_IDS = [4035, 4036, 4064, 4065, 4071, 4072];

// (2) split-remediated combos: row id -> actual day-of order total (cents).
const TOTAL_FIX: Array<[number, number]> = [
  [5722, 37479], // ta8E race → FastTrax $374.79
  [5721, 15556], // ta8E bowl → HeadPinz $155.56
  [5665, 18740], // t4TW race → $187.40
  [5664, 13528], // t4TW bowl → $135.28
  [5613, 9370], // bhoo race → $93.70
  [5612, 6922], // bhoo bowl → $69.22
  [5301, 4685], // vRrK race → $46.85
  [5300, 3621], // vRrK bowl → $36.21
];

console.log(APPLY ? "=== APPLY ===\n" : "=== DRY RUN (no writes) — pass --apply ===\n");

console.log("(1) Un-tag false positives:");
const untag = (await q`
  SELECT id, product_kind, guest_name, combo_special_id, total_cents
  FROM bowling_reservations WHERE id = ANY(${UNTAG_ROW_IDS}) ORDER BY id
`) as Array<Record<string, unknown>>;
for (const r of untag) {
  console.log(`  #${r.id} ${String(r.product_kind).padEnd(5)} ${String(r.guest_name).slice(0, 16).padEnd(16)} combo=${r.combo_special_id} → NULL`);
}
if (APPLY) {
  const res = await q`UPDATE bowling_reservations SET combo_special_id = NULL WHERE id = ANY(${UNTAG_ROW_IDS})`;
  console.log(`  ...untagged ${(res as { rowCount?: number }).rowCount ?? UNTAG_ROW_IDS.length} rows`);
}

console.log("\n(2) Fix split-remediated totals:");
for (const [id, cents] of TOTAL_FIX) {
  const cur = (await q`SELECT id, product_kind, guest_name, total_cents, deposit_cents FROM bowling_reservations WHERE id = ${id}`) as Array<Record<string, unknown>>;
  const r = cur[0];
  if (!r) {
    console.log(`  #${id} NOT FOUND — skip`);
    continue;
  }
  console.log(`  #${id} ${String(r.product_kind).padEnd(5)} ${String(r.guest_name).slice(0, 16).padEnd(16)} total $${(Number(r.total_cents) / 100).toFixed(2)}/dep $${(Number(r.deposit_cents) / 100).toFixed(2)} → $${(cents / 100).toFixed(2)} (both)`);
  if (APPLY) {
    await q`UPDATE bowling_reservations SET total_cents = ${cents}, deposit_cents = ${cents} WHERE id = ${id}`;
  }
}
console.log(APPLY ? "\n=== DONE ===" : "\n=== DRY RUN COMPLETE ===");
