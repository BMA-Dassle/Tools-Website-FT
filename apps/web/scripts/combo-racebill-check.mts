/** Do combo race legs have a bmi_bill_id (drives the v2 View)? READ-ONLY. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const rows = (await q`
  SELECT guest_name, bmi_bill_id, bmi_reservation_number
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL AND product_kind = 'race'
  ORDER BY booked_at
`) as Array<Record<string, unknown>>;
for (const r of rows)
  console.log(`${String(r.guest_name).slice(0, 16).padEnd(16)} bill=${r.bmi_bill_id ?? "—"} res=${r.bmi_reservation_number ?? "—"}`);
