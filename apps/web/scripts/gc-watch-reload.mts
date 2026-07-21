/** READ-ONLY: watch for a new web reload row and trace it to completion. */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABASE_URL=(.+)$/m);
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, "");
}
const sql = neon(process.env.DATABASE_URL!);
const startedAt = new Date().toISOString();
const deadline = Date.now() + 6 * 60_000;
const seen = new Map<string, string>();

console.log(`watching for reload rows created after ${startedAt} ...`);
while (Date.now() < deadline) {
  const rows = await sql`
    SELECT txn_id, account_number, location_code, tokens, amount_cents, state,
           load_state, queue_state, claimed_by, eis_code, eis_description, loaded_via,
           created_at, queued_at, claimed_at, acked_at
    FROM intercard_transactions
    WHERE kind = 'reload' AND created_at > ${startedAt}
    ORDER BY created_at ASC
  `;
  let allDone = rows.length > 0;
  for (const r of rows) {
    const sig = `${r.state}/${r.load_state}/${r.queue_state}`;
    if (seen.get(r.txn_id as string) !== sig) {
      seen.set(r.txn_id as string, sig);
      console.log(
        `${new Date().toISOString()} card=${r.account_number} loc=${r.location_code} ` +
          `${r.tokens}tok $${(Number(r.amount_cents) / 100).toFixed(2)} → ${sig} ` +
          `claimed_by=${r.claimed_by ?? "-"} eis=${r.eis_code ?? "-"} via=${r.loaded_via ?? "-"}`,
      );
    }
    if (r.load_state !== "loaded") allDone = false;
  }
  if (allDone && rows.length > 0) {
    const r = rows[rows.length - 1];
    const q = new Date(r.queued_at as string).getTime();
    const a = r.acked_at ? new Date(r.acked_at as string).getTime() : NaN;
    if (Number.isFinite(a)) console.log(`DONE — queued→acked in ${a - q} ms`);
    else console.log("DONE");
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 4000));
}
console.log("timed out after 6 min with no completed reload row");
