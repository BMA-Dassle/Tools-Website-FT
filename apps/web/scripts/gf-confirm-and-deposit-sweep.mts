/** READ-ONLY sweep for two systemic GF defects:
 *  (1) Money taken (deposit_paid/balance_charged) but BMI project NOT at a confirmed
 *      state — the "re-sign didn't re-confirm" gap (Suffolk 49972983).
 *  (2) Portal shows inflated "deposit paid": status=deposit_paid but
 *      deposit_due_cents != collected_cents (dispatch flipped due→full within 96h).
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const d = (c: number) => `$${(c / 100).toFixed(2)}`;
// Confirmed-ish states: -3 Confirmation; per-center Confirmation+Waiver; also accept
// "completed-ish" post states if any. (FM waiver 3274635, Naples 1191926.)
const CONFIRMED_STATES = new Set(["-3", "3274635", "1191926"]);
const { sql } = await import("@/lib/db");
const { fetchProject } = await import("@/lib/bmi-office-actions");
const q = sql();

const rows = (await q`
  SELECT id, event_number, event_name, center_code, status, bmi_reservation_id,
         total_cents, deposit_due_cents, collected_cents, balance_cents, event_date,
         deposit_paid_at
  FROM group_function_quotes
  WHERE status IN ('deposit_paid','balance_charged','resign_required')
    AND bmi_reservation_id IS NOT NULL
    AND event_date >= NOW() - INTERVAL '7 days'
  ORDER BY event_date ASC
`) as Array<Record<string, any>>;

console.log(`scanning ${rows.length} money-taken quotes (event within last 7d or future)…\n`);
const unconfirmed: string[] = [];
const inflated: string[] = [];
for (const r of rows) {
  // (2) inflated deposit display
  if (r.status === "deposit_paid" && r.deposit_due_cents !== r.collected_cents && r.collected_cents > 0) {
    inflated.push(`  #${r.id} ${r.event_number} "${r.event_name}" ${r.center_code}: portal shows depositPaid=${d(r.deposit_due_cents)} but collected=${d(r.collected_cents)} (bal ${d(r.balance_cents)})`);
  }
  // (1) BMI not confirmed
  let stateId = "?";
  try {
    const p = await fetchProject(r.center_code, String(r.bmi_reservation_id));
    stateId = p ? String(p.stateId) : "FETCH-NULL";
  } catch { stateId = "FETCH-ERR"; }
  if (!CONFIRMED_STATES.has(stateId)) {
    unconfirmed.push(`  #${r.id} ${r.event_number} "${r.event_name}" ${r.center_code} ${r.status} proj=${r.bmi_reservation_id} stateId=${stateId} evt=${String(r.event_date).slice(0,16)} collected=${d(r.collected_cents)}`);
  }
}
console.log(`\n=== (1) MONEY TAKEN BUT BMI NOT CONFIRMED (${unconfirmed.length}) ===`);
console.log(unconfirmed.join("\n") || "  none");
console.log(`\n=== (2) INFLATED DEPOSIT-PAID DISPLAY (${inflated.length}) ===`);
console.log(inflated.join("\n") || "  none");
process.exit(0);
