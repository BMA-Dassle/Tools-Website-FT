/**
 * READ-ONLY: find Wendy Greisheimer's Square payment for bill
 * pack-1777679112182-a3ml (5/1 7:47p ET) and check refund status.
 *
 * Run from apps/web:  npx tsx scripts/parked-racepack-wendy-square.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const SQ_HEADERS = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
};
const BILL = "pack-1777679112182-a3ml";
let cursor: string | undefined;
for (let page = 0; page < 10; page++) {
  const qs = new URLSearchParams({
    location_id: "LAB52GY480CJF",
    begin_time: "2026-05-01T20:00:00Z",
    end_time: "2026-05-02T06:00:00Z",
    limit: "100",
  });
  if (cursor) qs.set("cursor", cursor);
  const res = await fetch(`https://connect.squareup.com/v2/payments?${qs}`, {
    headers: SQ_HEADERS,
  });
  const data = JSON.parse(await res.text());
  for (const p of data.payments ?? []) {
    if (typeof p.note === "string" && p.note.includes(BILL)) {
      const card = p.card_details?.card;
      console.log(`payment ${p.id}`);
      console.log(`  status=${p.status} created=${p.created_at}`);
      console.log(`  amount=$${(p.amount_money?.amount ?? 0) / 100} refunded=$${(p.refunded_money?.amount ?? 0) / 100}`);
      console.log(`  card=${card?.card_brand} ****${card?.last_4} buyer=${p.buyer_email_address}`);
      console.log(`  note=${p.note}`);
      console.log(`  receipt=${p.receipt_url}`);
      console.log(`  refund_ids=${JSON.stringify(p.refund_ids ?? [])}`);
      process.exit(0);
    }
  }
  cursor = data.cursor;
  if (!cursor) break;
}
console.log("NO payment found with that bill ref in the window");
