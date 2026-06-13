/** Read-only: compare each failing quote's stored location vs its day-of order's location. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const headers = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-08-21",
};
const { sql } = await import("@/lib/db");
const q = sql();

for (const id of [119, 128]) {
  const [quote] = (await q`
    SELECT id, event_number, center_code, square_location_id, square_dayof_order_id
    FROM group_function_quotes WHERE id = ${id}
  `) as Array<Record<string, string>>;
  const res = await fetch(
    `https://connect.squareup.com/v2/orders/${quote.square_dayof_order_id}`,
    { headers },
  );
  const j = (await res.json()) as { order?: { location_id?: string } };
  const orderLoc = j.order?.location_id;
  console.log(
    `quote=${id} (${quote.event_number}, ${quote.center_code}) ` +
      `quote.location=${quote.square_location_id} order.location=${orderLoc} ` +
      `match=${quote.square_location_id === orderLoc}`,
  );
}
process.exit(0);
