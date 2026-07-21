/** READ-ONLY: all game-card ledger rows from the last 15 minutes. */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABASE_URL=(.+)$/m);
  if (m) process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, "");
}
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`
  SELECT kind, account_number, location_code, tokens, amount_cents, state,
         load_state, queue_state, claimed_by, eis_code, loaded_via,
         created_at, queued_at, acked_at
  FROM intercard_transactions
  WHERE created_at > NOW() - INTERVAL '15 minutes'
  ORDER BY created_at DESC
`;
console.log(rows.length ? JSON.stringify(rows, null, 1) : "NO rows in the last 15 minutes");
