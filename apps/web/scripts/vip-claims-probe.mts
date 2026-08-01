/** Read-only probe: per-item claim state for a voucher code. */
import { readFileSync } from "node:fs";
const env = readFileSync("C:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
process.env.DATABASE_URL = m![1].trim().replace(/^"|"$/g, "");
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const code = process.argv[2] ?? "HPWZ96RZ4SX";
const rows = await sql`
  SELECT id, item_index, status, txn_id, comp_name, created_at, released_at
  FROM voucher_claims WHERE code = ${code} ORDER BY item_index, created_at`;
for (const r of rows)
  console.log(
    `item ${r.item_index} · ${r.status} · txn=${String(r.txn_id).slice(0, 40)} · ${r.comp_name ?? ""} · created ${r.created_at}${r.released_at ? ` · released ${r.released_at}` : ""}`,
  );
if (!rows.length) console.log("no claim rows");
