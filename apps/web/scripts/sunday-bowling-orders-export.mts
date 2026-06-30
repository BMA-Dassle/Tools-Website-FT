/**
 * READ-ONLY: Export Sunday's bowling (open+kbf) day-of orders as CSV for QBO
 * reconciliation. Columns: res id, guest, kind, neon status, Square order id,
 * order state, total, amount due, gift card GAN, location.
 *   node --env-file=apps/web/.env.local apps/web/scripts/sunday-bowling-orders-export.mts 2026-06-14 > c:/tmp/sunday-bowling-orders.csv
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* next */
  }
}
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const DAY = process.argv[2] ?? "2026-06-14";
const LOC: Record<string, string> = { TXBSQN0FEKQ11: "HeadPinz Fort Myers", PPTR5G2N0QXF7: "HeadPinz Naples" };

const rows = (await sql`
  SELECT id, product_kind, status, square_dayof_order_id, square_gift_card_gan,
         deposit_cents, total_cents, guest_name, center_code, booked_at
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date = ${DAY}::date
    AND product_kind IN ('open','kbf') AND combo_special_id IS NULL
    AND square_gift_card_id IS NOT NULL AND square_gift_card_id <> ''
  ORDER BY id
`) as any[];

async function order(id: string) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  const o = (await res.json().catch(() => ({}))).order;
  return o ? { state: o.state, total: o.total_money?.amount ?? 0, due: o.net_amount_due_money?.amount ?? 0 } : null;
}
const csv = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dollars = (c: number) => (c / 100).toFixed(2);

const header = [
  "res_id", "guest", "kind", "neon_status", "square_order_id", "order_state",
  "order_total", "amount_due", "gift_card_gan", "location", "booked_at_utc",
];
console.log(header.join(","));

for (const r of rows) {
  let orderId: string = r.square_dayof_order_id;
  try {
    const p = JSON.parse(r.square_dayof_order_id);
    if (Array.isArray(p) && p.length) orderId = p[0];
  } catch {
    /* bare */
  }
  const os = orderId ? await order(orderId) : null;
  console.log(
    [
      r.id,
      csv(r.guest_name),
      r.product_kind,
      r.status,
      orderId ?? "",
      os?.state ?? "FETCH_FAIL",
      os ? dollars(os.total) : dollars(r.total_cents),
      os ? dollars(os.due) : "",
      r.square_gift_card_gan ?? "",
      csv(LOC[r.center_code] ?? r.center_code),
      r.booked_at instanceof Date ? r.booked_at.toISOString() : String(r.booked_at),
    ]
      .map(csv)
      .join(","),
  );
}
process.exit(0);
