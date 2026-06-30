/** Check short codes + their redis target URLs for a combo's two legs. READ-ONLY. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const redis = (await import("@/lib/redis")).default;

const rows = (await q`
  SELECT id, guest_name, product_kind, short_code, square_deposit_order_id AS dep
  FROM bowling_reservations WHERE combo_special_id IS NOT NULL
  ORDER BY square_deposit_order_id, product_kind
`) as Array<Record<string, unknown>>;

for (const r of rows) {
  const code = r.short_code as string | null;
  let target = "—";
  if (code) {
    try {
      target = (await redis.get(`short:${code}`)) ?? "(no redis)";
    } catch {
      target = "(redis err)";
    }
  }
  console.log(
    `${String(r.guest_name).slice(0, 16).padEnd(16)} ${String(r.product_kind).padEnd(5)} code=${code ?? "—"}\n     → ${target}`,
  );
}
process.exit(0);
