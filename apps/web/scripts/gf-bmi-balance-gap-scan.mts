/** READ-ONLY: find GF events fully paid on our side but still showing a balance in BMI —
 *  the "only the deposit was recorded to BMI" gap. Flags events where collected≈total but
 *  the BMI project balance > $1. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const d=(c:number)=>`$${(c/100).toFixed(2)}`;
const { sql } = await import("@/lib/db");
const { fetchProject } = await import("@/lib/bmi-office-actions");
const q = sql();
// Fully-paid-on-our-side events with a BMI project, recent or upcoming.
const rows = (await q`
  SELECT id, event_number, event_name, center_code, status, bmi_reservation_id,
         total_cents, collected_cents, balance_cents, deposit_due_cents, event_date
  FROM group_function_quotes
  WHERE bmi_reservation_id IS NOT NULL
    AND total_cents > 0
    AND collected_cents >= total_cents - 50
    AND status IN ('balance_charged','completed','deposit_paid')
    AND event_date >= NOW() - INTERVAL '45 days'
  ORDER BY event_date DESC
`) as Array<Record<string,any>>;
console.log(`scanning ${rows.length} fully-paid events for BMI balance > $1...\n`);
const gaps: any[] = [];
for (const r of rows) {
  let bal = -1;
  try { const p = await fetchProject(r.center_code, String(r.bmi_reservation_id)); bal = p ? Number(p.balance) : -1; } catch {}
  if (bal > 1) {
    gaps.push({ ...r, bmiBal: bal });
    console.log(`GAP #${r.id} ${r.event_number} "${r.event_name}" ${r.center_code} ${r.status} | ourTotal=${d(r.total_cents)} collected=${d(r.collected_cents)} | BMI balance=$${bal.toFixed(2)} | proj=${r.bmi_reservation_id} evt=${String(r.event_date).slice(4,15)}`);
  }
}
console.log(`\n${gaps.length} events with an un-recorded BMI balance (of ${rows.length} fully-paid).`);
console.log(`Total un-recorded in BMI: $${gaps.reduce((s,g)=>s+g.bmiBal,0).toFixed(2)}`);
process.exit(0);
