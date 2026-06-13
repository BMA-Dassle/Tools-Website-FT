/** Read-only: inspect the new canceled payment + all recent payments at the HeadPinz location. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const headers = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-12-18",
};
const SQ = "https://connect.squareup.com/v2";

const res = await fetch(
  `${SQ}/payments?location_id=LAB52GY480CJF&begin_time=2026-06-12T18:00:00Z&sort_order=DESC&limit=20`,
  { headers },
);
const j = (await res.json()) as { payments?: Array<Record<string, unknown>> };
for (const p of j.payments || []) {
  console.log(
    JSON.stringify({
      id: p.id,
      status: p.status,
      amount: (p.amount_money as { amount?: number })?.amount,
      source: p.source_type,
      order: p.order_id,
      created: p.created_at,
      note: p.note,
    }),
  );
}
process.exit(0);
