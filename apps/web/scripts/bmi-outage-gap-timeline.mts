/** READ-ONLY: for the events the recon flagged as short in BMI, when did the money
 *  actually get collected on our side? Separates "today's outage" from older backlog. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const IDS = [157, 238, 173, 12, 269, 14, 333, 257, 56, 74, 317, 234, 233, 245, 181];
const { sql } = await import("@/lib/db");
const q = sql();

const rows = (await q`
  SELECT id, event_number, event_name, status, event_date, created_at, updated_at,
         deposit_paid_at, balance_paid_at, dayof_paid_at
  FROM group_function_quotes WHERE id = ANY(${IDS})
  ORDER BY GREATEST(COALESCE(balance_paid_at, deposit_paid_at), COALESCE(deposit_paid_at, balance_paid_at)) DESC NULLS LAST
`) as Array<Record<string, any>>;
console.log("── quote payment timestamps (most recent money first) ──");
for (const r of rows)
  console.log(
    `  #${String(r.id).padEnd(4)} ${String(r.event_number).padEnd(6)} ${String(r.status).padEnd(16)} evt=${String(r.event_date).slice(4, 15)} dep_paid=${String(r.deposit_paid_at ?? "-").slice(0, 24).padEnd(25)} bal_paid=${String(r.balance_paid_at ?? "-").slice(0, 24).padEnd(25)} dayof=${String(r.dayof_paid_at ?? "-").slice(0, 24).padEnd(25)} upd=${String(r.updated_at).slice(0, 24)}`,
  );

console.log("\n── contract_audit_log, payment-ish events ──");
const log = (await q`
  SELECT quote_id, event, created_at, metadata
  FROM contract_audit_log
  WHERE quote_id = ANY(${IDS})
    AND created_at >= NOW() - INTERVAL '3 days'
  ORDER BY created_at DESC
  LIMIT 100
`) as Array<Record<string, any>>;
for (const r of log)
  console.log(
    `  #${String(r.quote_id).padEnd(4)} ${String(r.event).padEnd(28)} ${String(r.created_at).slice(0, 24)} ${JSON.stringify(r.metadata ?? {}).slice(0, 100)}`,
  );
if (!log.length) console.log("  (no audit rows in last 3 days)");
process.exit(0);
