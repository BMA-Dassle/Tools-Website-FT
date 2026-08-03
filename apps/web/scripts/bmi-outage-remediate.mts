/** Remediation for the 2026-08-03 BMI Office auth outage.
 *
 *  Records to BMI the project payments that confirmAndRecordBmiPayment swallowed
 *  when Pandora's Office auth endpoint was returning 500s. Scoped to the two
 *  events proven affected by the Vercel logs AND independently re-verified here
 *  against BMI's live payment ledger before each write.
 *
 *  Safety:
 *   - PREVIEW by default. --commit writes.
 *   - Re-reads the project immediately before writing; if BMI already has the
 *     money (someone recorded it manually, or a retry landed), it SKIPS. So this
 *     is safe to re-run and cannot double-post.
 *   - Never records more than BMI's own remaining balance.
 *   - Leaves a private note so the center can see why the payment date differs
 *     from the charge date.
 *
 *  Usage: npx tsx scripts/bmi-outage-remediate.mts [--commit]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const COMMIT = process.argv.includes("--commit");
const d = (c: number) => `$${(c / 100).toFixed(2)}`;

/** The events the outage cost us, with the charge that failed to post. */
const TARGETS = [
  {
    quoteId: 173,
    eventNumber: "3373",
    label: "Fireservice Inc — deposit",
    expectCents: 177256,
    chargedAt: "2026-08-03 15:41 ET",
  },
  {
    quoteId: 317,
    eventNumber: "3437",
    label: "FSW — auto-charged balance",
    expectCents: 34139,
    chargedAt: "2026-08-03 15:00 ET",
  },
];

const { sql } = await import("@/lib/db");
const { fetchProject, recordProjectPayment, appendProjectPrivateNote, noteTimestamp } =
  await import("@/lib/bmi-office-actions");
const q = sql();

console.log(`MODE: ${COMMIT ? "COMMIT" : "PREVIEW"}\n`);
let wrote = 0;
let writtenCents = 0;

for (const t of TARGETS) {
  const [r] = (await q`
    SELECT id, event_number, event_name, center_code, status, bmi_reservation_id,
           total_cents, collected_cents
    FROM group_function_quotes WHERE id = ${t.quoteId}
  `) as Array<Record<string, any>>;
  if (!r) {
    console.log(`#${t.quoteId} — quote not found, SKIP`);
    continue;
  }

  const p = (await fetchProject(r.center_code, String(r.bmi_reservation_id))) as any;
  if (!p) {
    console.log(`#${r.id} ${r.event_number} — BMI project fetch failed, SKIP (re-run later)`);
    continue;
  }
  const pays = (p.payments || []).filter((x: any) => !x.voidedDate);
  const recordedCents = Math.round(
    pays.reduce((s: number, x: any) => s + (Number(x.amount) || 0), 0) * 100,
  );
  const balCents = Math.round(Number(p.balance || 0) * 100);
  const gapCents = r.collected_cents - recordedCents;
  const recordCents = Math.max(0, Math.min(gapCents, balCents));

  console.log(
    `#${r.id} ${r.event_number} ${t.label}\n` +
      `    ourCollected=${d(r.collected_cents)}  bmiRecorded=${d(recordedCents)}  bmiBalance=${d(balCents)}  gap=${d(gapCents)}`,
  );

  if (recordCents <= 0) {
    console.log(`    → nothing to record (BMI already square). SKIP\n`);
    continue;
  }
  if (recordCents !== t.expectCents) {
    console.log(
      `    → computed ${d(recordCents)} but expected ${d(t.expectCents)} from the outage log.\n` +
        `      Recording the COMPUTED amount (BMI ledger is the authority), but flagging the difference.`,
    );
  }
  console.log(`    → RECORD ${d(recordCents)} to project ${r.bmi_reservation_id}\n`);

  if (COMMIT) {
    await recordProjectPayment({
      centerCode: r.center_code,
      projectId: String(r.bmi_reservation_id),
      amountDollars: recordCents / 100,
    });
    await appendProjectPrivateNote({
      centerCode: r.center_code,
      projectId: String(r.bmi_reservation_id),
      note:
        `[${noteTimestamp()}] Recorded ${d(recordCents)} collected ${t.chargedAt}. ` +
        `Payment was taken successfully on the card at that time but could not post to BMI — ` +
        `the Office API auth endpoint was returning 500s during the 2026-08-03 outage. ` +
        `Backfilled after the outage cleared; the payment date above is the backfill date, not the charge date.`,
    }).catch((err) => console.log(`    (note write failed, payment still recorded: ${err})`));
    wrote++;
    writtenCents += recordCents;
    console.log(`    ✓ recorded\n`);
  }
}

console.log(
  COMMIT
    ? `\nDone. Recorded ${wrote} payment(s) totalling ${d(writtenCents)} to BMI.`
    : `\nPreview only — nothing written. Re-run with --commit to apply.`,
);
process.exit(0);
