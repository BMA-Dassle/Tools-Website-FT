/** Protective HOLD: pause the 72h balance auto-charge for quote 150 (H1174) by
 *  setting approval_required=TRUE (the exact flag getQuotesNeedingBalanceCharge
 *  excludes). Reversible. Also reports how close we are to the 72h window. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

const before = (await q`SELECT event_date, status, approval_required, balance_paid_at, balance_cents,
  EXTRACT(EPOCH FROM (event_date - INTERVAL '72 hours' - NOW()))/60 AS mins_until_window
  FROM group_function_quotes WHERE id = 150`) as Array<Record<string, unknown>>;
console.log("BEFORE:", JSON.stringify(before[0], null, 2));
const mins = Number(before[0].mins_until_window);
console.log(`\n72h charge window opens in ${mins.toFixed(1)} minutes ${mins <= 0 ? "(ALREADY OPEN — cron will charge on next 15-min run!)" : ""}`);

if (before[0].balance_paid_at) {
  console.log("balance already paid — no hold needed.");
  process.exit(0);
}

const upd = (await q`UPDATE group_function_quotes
  SET approval_required = TRUE, updated_at = NOW()
  WHERE id = 150 AND balance_paid_at IS NULL AND status = 'deposit_paid'
  RETURNING id, approval_required`) as Array<Record<string, unknown>>;
console.log("\nHOLD applied:", JSON.stringify(upd[0] ?? "(no row updated)"));

await q`INSERT INTO contract_audit_log (quote_id, event, actor_email, metadata)
  VALUES (150, 'balance_charge_held', ${process.env.USER_EMAIL ?? "eric@headpinz.com"},
    ${JSON.stringify({ reason: "stale day-of order ($425.43, 1 party) vs contract ($850.86, 2 parties); pausing auto-charge of $638.14 pending owner decision", tool: "h1174-hold.mts" })})`;
console.log("audit logged: balance_charge_held");
process.exit(0);
