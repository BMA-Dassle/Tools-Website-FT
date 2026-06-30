/** Rule A remediation: for fully-paid GF events, record to BMI the amount we COLLECTED
 *  that BMI doesn't yet have — capped at the BMI balance, never exceeding collected.
 *  recordCents = clamp(collected_cents - recordedInBmi, 0, bmiBalance). Idempotent: re-runs
 *  record 0 once caught up. PREVIEW by default; --commit writes payments to BMI. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const COMMIT = process.argv.includes("--commit");
const d=(c:number)=>`$${(c/100).toFixed(2)}`;
const { sql } = await import("@/lib/db");
const { fetchProject, recordProjectPayment, appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
const q = sql();
const rows = (await q`
  SELECT id, event_number, event_name, center_code, status, bmi_reservation_id, total_cents, collected_cents, event_date
  FROM group_function_quotes
  WHERE bmi_reservation_id IS NOT NULL AND total_cents > 0
    AND collected_cents >= total_cents - 50
    AND status IN ('balance_charged','completed','deposit_paid')
    AND event_date >= NOW() - INTERVAL '45 days'
  ORDER BY event_date DESC
`) as Array<Record<string,any>>;

let toRecord = 0, count = 0, residualTotal = 0;
console.log(`MODE: ${COMMIT ? "COMMIT" : "PREVIEW"} — scanning ${rows.length} fully-paid events\n`);
for (const r of rows) {
  let p:any; try { p = await fetchProject(r.center_code, String(r.bmi_reservation_id)); } catch { console.log(`  #${r.id} fetch-fail`); continue; }
  if (!p) continue;
  const balCents = Math.round(Number(p.balance||0)*100);
  if (balCents <= 1) continue;
  const recordedSum = (p.payments||[]).filter((x:any)=>!x.voidedDate).reduce((s:number,x:any)=>s+(Number(x.amount)||0),0);
  const recordedCents = Math.round(recordedSum*100);
  const recordCents = Math.max(0, Math.min(r.collected_cents - recordedCents, balCents));
  if (recordCents <= 0) continue;
  const residual = balCents - recordCents;
  count++; toRecord += recordCents; residualTotal += residual;
  console.log(`#${r.id} ${r.event_number} "${String(r.event_name).slice(0,32)}" ${r.center_code} | collected=${d(r.collected_cents)} bmiRecorded=${d(recordedCents)} bmiBal=${d(balCents)} => RECORD ${d(recordCents)}${residual>1?`  (residual ${d(residual)} = BMI total > ours)`:""}`);
  if (COMMIT) {
    await recordProjectPayment({ centerCode: r.center_code, projectId: String(r.bmi_reservation_id), amountDollars: recordCents/100 });
    await appendProjectPrivateNote({ centerCode: r.center_code, projectId: String(r.bmi_reservation_id), note: `[${noteTimestamp()}] Recorded collected balance $${(recordCents/100).toFixed(2)} to BMI (was missing — only deposit had been recorded).` }).catch(()=>{});
  }
}
console.log(`\n${count} events. Total to record: ${d(toRecord)}. Residual left (BMI-total mismatches): ${d(residualTotal)}.`);
process.exit(0);
