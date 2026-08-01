/** One-off remediation (owner 2026-07-31): release the Shuffly leg that a
 *  no-shuffly cart wrongly claimed+spent (§0b claimed unallocated legs — bug
 *  fixed in the same push). */
import { readFileSync } from "node:fs";
const env = readFileSync("C:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
process.env.DATABASE_URL = m![1].trim().replace(/^"|"$/g, "");
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`
  UPDATE voucher_claims
  SET status = 'released', released_at = NOW(),
      released_reason = 'manual: spent by a cart it did not cover (unallocated-leg claim bug, fixed 2026-07-31)'
  WHERE code = 'HPWZ96RZ4SX' AND item_index = 4 AND status = 'spent'
  RETURNING item_index, status`;
console.log(JSON.stringify(rows));
