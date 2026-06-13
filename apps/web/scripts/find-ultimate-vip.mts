/** Read-only: find Ultimate VIP combo bookings in Square since launch (2026-06-11). */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const headers = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};

const LOCATIONS = ["TXBSQN0FEKQ11", "LAB52GY480CJF"]; // FastTrax FM + HeadPinz FM
let cursor: string | undefined;
let scanned = 0;
const hits: Array<Record<string, unknown>> = [];

do {
  const res = await fetch("https://connect.squareup.com/v2/orders/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      location_ids: LOCATIONS,
      limit: 100,
      cursor,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: "2026-06-10T00:00:00Z" } },
        },
        sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
      },
    }),
  });
  const j = (await res.json()) as {
    orders?: Array<Record<string, never>>;
    cursor?: string;
    errors?: unknown;
  };
  if (j.errors) {
    console.error(JSON.stringify(j.errors));
    break;
  }
  for (const o of j.orders || []) {
    scanned++;
    const items = (o["line_items"] as Array<{ name?: string; quantity?: string }>) || [];
    const match = items.some((li) => /ultimate|vip|combo/i.test(li.name || ""));
    const note = (o["note"] as string) || (o["ticket_name"] as string) || "";
    if (match || /ultimate|vip|combo/i.test(note)) {
      hits.push({
        id: o["id"],
        created: o["created_at"],
        state: o["state"],
        location: o["location_id"],
        total: (o["total_money"] as { amount?: number })?.amount,
        items: items.map((li) => `${li.quantity}x ${li.name}`),
        note,
      });
    }
  }
  cursor = j.cursor;
} while (cursor && scanned < 800);

console.log(`scanned ${scanned} orders since 6/10; Ultimate VIP/combo hits: ${hits.length}`);
for (const h of hits) console.log(JSON.stringify(h));
process.exit(0);
