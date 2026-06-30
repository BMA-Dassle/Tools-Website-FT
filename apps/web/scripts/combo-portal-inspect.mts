/** Inspect combo_special_id tagging + shared keys for the VIP portal grouping. READ-ONLY. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

const rows = (await q`
  SELECT id, product_kind, combo_special_id,
         square_dayof_order_id AS dayof, square_deposit_order_id AS deposit,
         square_gift_card_id AS gc, total_cents, deposit_cents, player_count,
         guest_name, booked_at, status
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
  ORDER BY booked_at, id
`) as Array<Record<string, unknown>>;

console.log(`${rows.length} rows tagged combo_special_id:\n`);
for (const r of rows) {
  console.log(
    `#${r.id} ${String(r.product_kind).padEnd(5)} combo=${r.combo_special_id} ` +
      `dayof=${String(r.dayof ?? "-").slice(0, 8)} deposit=${String(r.deposit ?? "-").slice(0, 8)} gc=${String(r.gc ?? "-").slice(0, 8)} ` +
      `tot=$${(Number(r.total_cents ?? 0) / 100).toFixed(2)} ppl=${r.player_count} ${String(r.guest_name ?? "").slice(0, 16).padEnd(16)} ${String(r.booked_at).slice(0, 10)} ${r.status}`,
  );
}
