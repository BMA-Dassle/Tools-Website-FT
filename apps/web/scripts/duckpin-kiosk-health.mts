/**
 * Is the FastTrax duckpin (QAMF center 11542) booking path healthy, or did the
 * 2026-07-28 Paul Chung orphan expose a systematic failure? Prints the column
 * list for bowling_reservations, then every 11542 row, newest first.
 * READ-ONLY.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

const cols = (await q`
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'bowling_reservations' ORDER BY ordinal_position
`) as Array<{ column_name: string; data_type: string }>;
console.log(`\n══ bowling_reservations columns (${cols.length}) ══`);
console.log(cols.map((c) => c.column_name).join(", "));

const ft = (await q`
  SELECT id, qamf_reservation_id, center_code, product_kind, booked_at, player_count, status,
         guest_name, guest_phone, deposit_cents, booking_source, checkin_method,
         combo_special_id, qamf_confirm_attempts, inserted_at
  FROM bowling_reservations
  WHERE center_code = 'LAB52GY480CJF'
  ORDER BY inserted_at DESC LIMIT 40
`) as Array<Record<string, any>>;
console.log(`\n══ FastTrax (LAB52GY480CJF) duckpin rows: ${ft.length} ══`);
for (const r of ft) {
  console.log(
    `  id=${r.id} qamf=${r.qamf_reservation_id} booked=${String(r.booked_at)} p=${r.player_count} ${r.status} "${r.guest_name}" ${r.guest_phone} dep=${r.deposit_cents} src=${r.booking_source} combo=${r.combo_special_id} attempts=${r.qamf_confirm_attempts} at=${String(r.inserted_at)}`,
  );
}

const phones = (await q`
  SELECT guest_phone, count(*) AS n, max(inserted_at) AS last
  FROM bowling_reservations
  WHERE inserted_at > now() - interval '14 days'
  GROUP BY guest_phone ORDER BY last DESC LIMIT 25
`) as Array<Record<string, any>>;
console.log(`\n══ recent guest_phone shapes (14d) ══`);
for (const r of phones) console.log(`  "${r.guest_phone}"  n=${r.n}  last=${String(r.last)}`);

const chung = (await q`
  SELECT id, qamf_reservation_id, center_code, booked_at, status, guest_name, guest_phone, inserted_at
  FROM bowling_reservations
  WHERE guest_email ILIKE '%chung1976%' OR guest_phone LIKE '%518%4297%' OR guest_name ILIKE '%chung%'
  ORDER BY inserted_at DESC LIMIT 10
`) as Array<Record<string, any>>;
console.log(`\n══ Chung rows: ${chung.length} ══`);
for (const r of chung) console.log(`  ${JSON.stringify(r)}`);
