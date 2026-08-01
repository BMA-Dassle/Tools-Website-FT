/** One-off (owner 2026-08-01): full reset of TEST voucher HPWZ96RZ4SX for
 *  reuse — release every spent/claimed row (item 1 was legitimately spent by
 *  the 02:40Z test booking; the owner wants the whole code fresh). */
import { readFileSync } from "node:fs";
const env = readFileSync("C:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
process.env.DATABASE_URL = m![1].trim().replace(/^"|"$/g, "");
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`
  UPDATE voucher_claims
  SET status = 'released', released_at = NOW(),
      released_reason = 'manual: owner reset of test voucher for reuse (2026-08-01)'
  WHERE code = 'HPWZ96RZ4SX' AND status IN ('spent', 'claimed')
  RETURNING item_index, status`;
console.log(JSON.stringify(rows));
