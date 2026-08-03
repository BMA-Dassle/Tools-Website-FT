/** READ-ONLY reconciliation after the 2026-08-03 BMI Office auth outage.
 *
 *  For EVERY group-function event with a BMI project and money collected on our
 *  side, compare what we collected against what BMI actually has recorded.
 *  Log-independent: this reads BMI's live payment ledger, so it catches gaps the
 *  Vercel logs missed (retention, sampling, or a swallowed error that never
 *  printed) as well as anything older than the outage.
 *
 *  Gap = collected_cents - sum(non-voided BMI payments). Positive gap means BMI
 *  is missing money we took.
 *
 *  Usage: npx tsx scripts/bmi-outage-recon.mts [daysBack=120]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const DAYS = Number(process.argv[2] || 120);
const d = (c: number) => `$${(c / 100).toFixed(2)}`;
const { sql } = await import("@/lib/db");
const { fetchProject } = await import("@/lib/bmi-office-actions");
const q = sql();

const rows = (await q`
  SELECT id, event_number, event_name, center_code, status, bmi_reservation_id,
         total_cents, collected_cents, event_date, updated_at
  FROM group_function_quotes
  WHERE bmi_reservation_id IS NOT NULL
    AND collected_cents > 0
    AND status NOT IN ('cancelled')
    AND event_date >= NOW() - (${DAYS} * INTERVAL '1 day')
  ORDER BY updated_at DESC
`) as Array<Record<string, any>>;

console.log(`Reconciling ${rows.length} GF events with collected money (last ${DAYS}d)\n`);

type Gap = Record<string, any>;
const gaps: Gap[] = [];
const fetchFails: Gap[] = [];
const overs: Gap[] = [];

for (const r of rows) {
  let p: any;
  try {
    p = await fetchProject(r.center_code, String(r.bmi_reservation_id));
  } catch (err) {
    fetchFails.push({ ...r, err: err instanceof Error ? err.message.slice(0, 80) : String(err) });
    continue;
  }
  if (!p) {
    fetchFails.push({ ...r, err: "null project" });
    continue;
  }
  const payments = (p.payments || []).filter((x: any) => !x.voidedDate);
  const recordedCents = Math.round(
    payments.reduce((s: number, x: any) => s + (Number(x.amount) || 0), 0) * 100,
  );
  const balCents = Math.round(Number(p.balance || 0) * 100);
  const gapCents = r.collected_cents - recordedCents;

  // Newest BMI payment date, to sanity-check "did the outage-window payment land"
  const lastPayDate = payments
    .map((x: any) => String(x.date || ""))
    .sort()
    .pop();

  const row = { ...r, recordedCents, balCents, gapCents, lastPayDate, payCount: payments.length };
  if (gapCents > 100) gaps.push(row);
  else if (gapCents < -100) overs.push(row);
}

const fmt = (g: Gap, extra = "") =>
  `  #${String(g.id).padEnd(4)} ${String(g.event_number).padEnd(6)} ${String(g.event_name).slice(0, 30).padEnd(30)} ${String(g.center_code).padEnd(11)} ${String(g.status).padEnd(16)} proj=${String(g.bmi_reservation_id).padEnd(9)} ourColl=${d(g.collected_cents).padEnd(10)} bmiRec=${d(g.recordedCents).padEnd(10)} bmiBal=${d(g.balCents).padEnd(10)} GAP=${d(g.gapCents)}${extra}`;

console.log(`\n═══ BMI MISSING MONEY WE COLLECTED (${gaps.length}) ═══`);
gaps.sort((a, b) => b.gapCents - a.gapCents);
for (const g of gaps) console.log(fmt(g, `  lastBmiPay=${String(g.lastPayDate).slice(0, 10)}`));
console.log(`  TOTAL MISSING FROM BMI: ${d(gaps.reduce((s, g) => s + g.gapCents, 0))}`);

console.log(`\n═══ BMI HAS MORE THAN WE COLLECTED — check for offline/POS payments (${overs.length}) ═══`);
overs.sort((a, b) => a.gapCents - b.gapCents);
for (const g of overs) console.log(fmt(g));

console.log(`\n═══ COULD NOT VERIFY (${fetchFails.length}) ═══`);
for (const g of fetchFails)
  console.log(
    `  #${g.id} ${g.event_number} ${String(g.event_name).slice(0, 30)} ${g.center_code} proj=${g.bmi_reservation_id} — ${g.err}`,
  );

console.log(
  `\nSummary: ${rows.length} checked · ${gaps.length} short in BMI · ${overs.length} over · ${fetchFails.length} unverifiable`,
);
process.exit(0);
