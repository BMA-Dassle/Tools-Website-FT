/** Read-only probe: the combo-voucher-reconcile sweep's candidate query
 *  (fixed inserted_at + cancelled filter), without minting anything. */
import { readFileSync } from "node:fs";
const env = readFileSync("C:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.+)$/m);
process.env.DATABASE_URL = m![1].trim().replace(/^"|"$/g, "");
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`
  SELECT
    bmi_bill_id,
    max(combo_special_id) AS combo_special_id,
    max(guest_email) AS guest_email,
    max(
      (SELECT count(DISTINCT t.e->>'assignedTo') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'heats')='array' THEN booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e))
    ) AS racer_count,
    bool_or(EXISTS (SELECT 1 FROM vouchers v WHERE v.bill_id = bowling_reservations.bmi_bill_id)) AS has_voucher
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
    AND bmi_bill_id IS NOT NULL
    AND status <> 'cancelled'
    AND inserted_at > NOW() - make_interval(days => 7)
  GROUP BY bmi_bill_id`;
console.log("rows:", rows.length);
for (const r of rows)
  console.log(
    `${String(r.bmi_bill_id)} · ${r.combo_special_id} · racers=${r.racer_count} · voucher=${r.has_voucher ? "yes" : "MISSING"} · ${String(r.guest_email ?? "").replace(/(.{3}).*@/, "$1…@")}`,
  );
