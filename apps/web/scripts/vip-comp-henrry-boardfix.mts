/**
 * Board-display fix for the comped VIP combo W57087 (rows 18546 bowl / 18547 race).
 *
 * 1. Stamp a SHARED square_deposit_order_id (the race day-of order id) on both
 *    legs — the combo board + receipt sibling-merge join on it, and a $0 comp
 *    has no real deposit order. deposit_cents stays 0 and there is no deposit
 *    payment id, so no settlement/refund rail can act on it.
 * 2. Owner ask: show the group total as $450.00 on the reservations board while
 *    the Square orders stay $0. Card total = sum of leg total_cents, so split
 *    $450 on the combo's own 61/38 revenue ratio: race $277.27 + bowl $172.73.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

const SHARED = "1OsUToxKtVFvjRS89uegLD7YJHXZY"; // race (FastTrax) day-of order — $0, OPEN

const race = await q`
  UPDATE bowling_reservations
  SET square_deposit_order_id = ${SHARED}, total_cents = 27727
  WHERE id = 18547 AND combo_special_id = 'race-bowl-v2' AND guest_email = 'henrry@headpinz.com'
  RETURNING id, square_deposit_order_id, total_cents, deposit_cents
`;
const bowl = await q`
  UPDATE bowling_reservations
  SET square_deposit_order_id = ${SHARED}, total_cents = 17273
  WHERE id = 18546 AND combo_special_id = 'race-bowl-v2' AND guest_email = 'henrry@headpinz.com'
  RETURNING id, square_deposit_order_id, total_cents, deposit_cents
`;
console.log("race:", race);
console.log("bowl:", bowl);
console.log("Board should now show ONE card, total $450.00, with race times + voucher QR.");
