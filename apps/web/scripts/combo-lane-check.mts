/** Where is the combo bowling lane stored? Inspect bowling legs' lane fields. READ-ONLY. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const rows = (await q`
  SELECT id, guest_name, product_kind, dayof_order_lane, qamf_reservation_id, dayof_order_sent_at,
         booking_metadata
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL AND product_kind IN ('open','kbf')
  ORDER BY booked_at
`) as Array<Record<string, unknown>>;
for (const r of rows) {
  const md = r.booking_metadata as Record<string, unknown> | null;
  const mdLane = md ? JSON.stringify(md).match(/"lane[^"]*":\s*("?[^",}]+"?)/i)?.[0] : null;
  console.log(
    `#${r.id} ${String(r.guest_name).slice(0, 16).padEnd(16)} lane=${r.dayof_order_lane ?? "—"} qamf=${r.qamf_reservation_id ?? "—"} sent=${r.dayof_order_sent_at ? "Y" : "N"} mdLane=${mdLane ?? "—"}`,
  );
}
