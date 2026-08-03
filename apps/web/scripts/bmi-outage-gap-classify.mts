/** READ-ONLY: classify the BMI-short events into ACTIONABLE vs EXPLAINED.
 *
 *  Not every "BMI has less than we collected" row is a missing update:
 *   - square_settled_order_id set  → the money settled on a POS check inside BMI's
 *     own POS. group-square-settled-close writes a NOTE only, deliberately. Recording
 *     a project payment would DOUBLE-COUNT.
 *   - dayof_paid_at set → day-of order paid at POS, same reasoning for that slice.
 *  Everything else is a genuine missing projectPayment.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const IDS = [157, 238, 173, 12, 269, 14, 333, 257, 56, 74, 317, 234, 233, 245, 181];
const d = (c: number) => `$${(c / 100).toFixed(2)}`;
const { sql } = await import("@/lib/db");
const { fetchProject } = await import("@/lib/bmi-office-actions");
const q = sql();

const rows = (await q`
  SELECT id, event_number, event_name, center_code, status, bmi_reservation_id,
         total_cents, collected_cents, event_date,
         deposit_paid_at, balance_paid_at, dayof_paid_at,
         square_settled_order_id, square_deposit_payment_id, square_balance_payment_id,
         dayof_payment_ids
  FROM group_function_quotes WHERE id = ANY(${IDS})
`) as Array<Record<string, any>>;

const actionable: any[] = [];
const explained: any[] = [];

for (const r of rows) {
  const p = (await fetchProject(r.center_code, String(r.bmi_reservation_id)).catch(
    () => null,
  )) as any;
  if (!p) {
    console.log(`  #${r.id} — could not fetch project`);
    continue;
  }
  const pays = (p.payments || []).filter((x: any) => !x.voidedDate);
  const recordedCents = Math.round(
    pays.reduce((s: number, x: any) => s + (Number(x.amount) || 0), 0) * 100,
  );
  const balCents = Math.round(Number(p.balance || 0) * 100);
  const gapCents = r.collected_cents - recordedCents;
  const posSettled = !!r.square_settled_order_id;
  const hasDayof = !!r.dayof_paid_at;
  const today = String(r.balance_paid_at ?? "").includes("Aug 03 2026") ||
    String(r.deposit_paid_at ?? "").includes("Aug 03 2026");

  // The safe amount to record is capped by BMI's own remaining balance: never
  // push more into BMI than BMI still thinks it is owed.
  const safeRecordCents = Math.max(0, Math.min(gapCents, balCents));

  const row = { ...r, recordedCents, balCents, gapCents, safeRecordCents, posSettled, hasDayof, today };
  if (posSettled || hasDayof) explained.push(row);
  else actionable.push(row);
}

const line = (g: any) =>
  `  #${String(g.id).padEnd(4)} ${String(g.event_number).padEnd(6)} ${String(g.event_name).slice(0, 28).padEnd(28)} ${String(g.center_code).padEnd(11)} proj=${String(g.bmi_reservation_id).padEnd(9)} ourColl=${d(g.collected_cents).padEnd(10)} bmiRec=${d(g.recordedCents).padEnd(10)} bmiBal=${d(g.balCents).padEnd(10)} gap=${d(g.gapCents).padEnd(10)} safeRecord=${d(g.safeRecordCents)}`;

console.log(`\n═══ A. TODAY'S OUTAGE — record to BMI (${actionable.filter((a) => a.today).length}) ═══`);
for (const g of actionable.filter((a) => a.today)) console.log(line(g));
console.log(
  `  subtotal safe-to-record: ${d(actionable.filter((a) => a.today).reduce((s, g) => s + g.safeRecordCents, 0))}`,
);

console.log(`\n═══ B. OLDER BACKLOG — same defect, pre-dates today (${actionable.filter((a) => !a.today).length}) ═══`);
for (const g of actionable.filter((a) => !a.today).sort((a, b) => b.safeRecordCents - a.safeRecordCents))
  console.log(line(g));
console.log(
  `  subtotal safe-to-record: ${d(actionable.filter((a) => !a.today).reduce((s, g) => s + g.safeRecordCents, 0))}`,
);

console.log(`\n═══ C. EXPLAINED — POS-settled / day-of, do NOT record (would double-count) (${explained.length}) ═══`);
for (const g of explained)
  console.log(
    `${line(g)}  [${g.posSettled ? "settled-order=" + String(g.square_settled_order_id).slice(0, 12) : ""}${g.hasDayof ? " dayof-paid" : ""}]`,
  );

process.exit(0);
