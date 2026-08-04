/**
 * READ-ONLY probe: Henrry Gomez comped VIP V2 (2026-08-02, BMI W57087).
 * The admin board shows only the bowling leg — confirm the race-leg Neon row
 * is missing, capture the bowling row's grouping keys, resolve the bill id
 * from the /s/z6owCy-M short link, and check the voucher row.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

console.log("── bowling_reservations rows for Henrry ──");
const rows = (await q`
  SELECT id, center_code, product_kind, status, booked_at, player_count,
         guest_name, guest_phone, bmi_bill_id, bmi_reservation_number,
         qamf_reservation_id, square_deposit_order_id, square_dayof_order_id,
         deposit_cents, total_cents, promo_code, promo_savings_cents,
         reward_discount_cents, combo_special_id, booking_source, notes,
         booking_metadata, inserted_at
  FROM bowling_reservations
  WHERE (guest_phone LIKE '%7866097355%' OR guest_email = 'henrry@headpinz.com')
    AND inserted_at > '2026-07-30'
  ORDER BY id
`) as Array<Record<string, unknown>>;
for (const r of rows) {
  const { booking_metadata, ...rest } = r;
  console.log(JSON.stringify(rest, null, 1));
  console.log("  booking_metadata:", JSON.stringify(booking_metadata)?.slice(0, 800));
}

console.log("\n── short link z6owCy-M ──");
try {
  const su = (await q`SELECT * FROM short_urls WHERE code = 'z6owCy-M'`) as Array<
    Record<string, unknown>
  >;
  console.log(JSON.stringify(su, null, 1));
} catch (e) {
  console.log("short_urls query failed:", (e as Error).message);
}

console.log("\n── vouchers minted 8/1–8/2 (bill-linked) ──");
try {
  const v = (await q`
    SELECT id, code, kind, bill_id, expires_at, voided_at, created_at,
           jsonb_array_length(items) AS item_count
    FROM vouchers
    WHERE created_at > '2026-08-01'
    ORDER BY created_at DESC
    LIMIT 12
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(v, null, 1));
} catch (e) {
  console.log("vouchers query failed:", (e as Error).message);
}
