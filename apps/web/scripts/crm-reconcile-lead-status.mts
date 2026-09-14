/**
 * Advance a lead's status when its CONTRACT is demonstrably further along.
 *
 * Owner, 2026-09-14, on Kara Simmons: "this event should be in lead its
 * contract sent double check and fix." L-129 (#2950) showed `assigned` on the
 * board while its contract had been signed on 1 July and the deposit paid —
 * so the queue card said "no touch · 1 h 33 m" about an event that is already
 * booked and paid for.
 *
 * Our status is meant to be the SALES view and the contract the money view of
 * one record, but they are written by different rails: a rep drags the board,
 * and the contract moves when the guest signs or pays. Nothing reconciled the
 * two, so a deal that progressed entirely through the guest's own actions left
 * our status wherever the rep last put it.
 *
 * ONE DIRECTION ONLY — FORWARD. This never pulls a status back. A rep who has
 * moved a deal on knows something the contract does not (a verbal yes, a
 * cancelled cheque), and a nightly job that reverted their work would be worse
 * than the drift it fixes. Lost and No-response are left alone entirely: they
 * are a human's judgement about a guest, not a state the money can infer.
 *
 * Re-runnable and idempotent: a second run finds nothing to do.
 *
 *   npx tsx scripts/crm-reconcile-lead-status.mts          # report only
 *   npx tsx scripts/crm-reconcile-lead-status.mts --apply  # write
 */
import fs from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");

/** How far along our own pipeline each status sits. Lost / No-response are absent on purpose. */
const OURS: Record<string, number> = {
  new: 0,
  assigned: 1,
  contacted: 2,
  waiting: 2,
  quote: 3,
  contract: 4,
  deposit: 5,
  confirmed: 6,
};

/** What each contract status PROVES about the deal, as one of our statuses. */
const FROM_CONTRACT: Record<string, string> = {
  pending_approval: "quote",
  contract_sent: "contract",
  resign_required: "contract",
  deposit_paid: "deposit",
  balance_link_sent: "deposit",
  balance_funded: "deposit",
  // The money is in. That is a won deal whatever the board says.
  balance_charged: "confirmed",
  completed: "confirmed",
};

interface Row {
  id: string;
  public_id: string;
  status_id: string;
  bmi_project_number: string | null;
  gf_status: string;
}

const rows = (await sql`
  SELECT l.id::text AS id, l.public_id, l.status_id, l.bmi_project_number, gfq.status AS gf_status
    FROM crm_leads l
    JOIN group_function_quotes gfq ON gfq.bmi_reservation_id = l.bmi_project_id
   WHERE l.archived_at IS NULL
     AND gfq.status NOT IN ('cancelled', 'denied', 'expired')
     -- A human's verdict on a guest is never inferred from the money.
     AND l.status_id NOT IN ('lost', 'noresp')
   ORDER BY l.id
`) as Row[];

const behind = rows
  .map((r) => ({ r, want: FROM_CONTRACT[r.gf_status] }))
  .filter(
    (x): x is { r: Row; want: string } =>
      !!x.want && (OURS[x.want] ?? 0) > (OURS[x.r.status_id] ?? 0),
  );

console.log(`${rows.length} leads with a live contract · ${behind.length} behind it`);
for (const { r, want } of behind)
  console.log(
    `  ${r.public_id.padEnd(7)} #${(r.bmi_project_number ?? "—").padEnd(7)} ` +
      `${r.status_id} → ${want}   (contract: ${r.gf_status})`,
  );

if (!behind.length) {
  console.log("nothing to do");
  process.exit(0);
}
if (!APPLY) {
  console.log("\nreport only — pass --apply to write");
  process.exit(0);
}

for (const { r, want } of behind) {
  await sql`UPDATE crm_leads SET status_id = ${want}, updated_at = now() WHERE id = ${r.id}::bigint`;
  // On the timeline, because a status that changed by itself must say who
  // changed it and why.
  await sql`
    INSERT INTO crm_activities (lead_id, actor_email, kind, occurred_at, body, meta)
    VALUES (
      ${r.id}::bigint, 'contract-reconcile', 'status', now(),
      ${`Status ${r.status_id} → ${want} — the contract is already ${r.gf_status}`},
      ${JSON.stringify({ from: r.status_id, to: want, gfStatus: r.gf_status, reconcile: true })}::jsonb
    )`;
  console.log(`  applied ${r.public_id}: ${r.status_id} → ${want}`);
}
console.log(`\n${behind.length} leads advanced`);
