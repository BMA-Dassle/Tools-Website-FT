/**
 * Read-only state dump for a group-function quote by event number.
 * Usage (from apps/web): npx tsx scripts/check-quote-state.mts H2821
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const eventNumber = process.argv[2] || "H2821";
const { sql } = await import("@/lib/db");
const q = sql();

const rows = (await q`
  SELECT id, event_number, event_name, status, event_date,
         event_date <= NOW() AS event_started,
         NOW() AS db_now,
         dayof_paid_at, dayof_payment_error, dayof_payment_ids,
         square_dayof_order_id, square_gift_card_gan, square_gift_card_id,
         approval_required, approved_at, reminders_suppressed,
         total_cents, collected_cents, balance_cents, balance_paid_at,
         line_items
  FROM group_function_quotes
  WHERE event_number = ${eventNumber}
  ORDER BY id DESC
`) as Array<Record<string, unknown>>;

console.log(JSON.stringify(rows, null, 2));
process.exit(0);
