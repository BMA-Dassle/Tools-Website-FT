/** READ-ONLY: how close is quote 150 to the 72h balance-charge window? */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const r = (await q`SELECT NOW() AS now, event_date, status, approval_required, balance_paid_at,
  balance_cents, saved_card_id IS NOT NULL AS has_card,
  EXTRACT(EPOCH FROM (event_date - INTERVAL '72 hours' - NOW()))/60 AS mins_until_window
  FROM group_function_quotes WHERE id = 150`) as Array<Record<string, unknown>>;
console.log(JSON.stringify(r[0], null, 2));
const mins = Number(r[0].mins_until_window);
console.log(`\n72h window opens in ${mins.toFixed(1)} min ${mins <= 0 ? "→ ALREADY OPEN; cron charges on next 15-min run" : ""}`);
console.log(`will auto-charge: ${!r[0].balance_paid_at && r[0].status === "deposit_paid" && !r[0].approval_required && r[0].has_card && mins <= 0 ? "YES — $" + (Number(r[0].balance_cents)/100).toFixed(2) : "no (held/paid/no-card/not-yet)"}`);
process.exit(0);
