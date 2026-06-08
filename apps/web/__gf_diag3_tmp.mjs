import { neon } from "@neondatabase/serverless";
const SQUARE_BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const j = (o) => JSON.stringify(o, null, 2);
const sql = neon(process.env.DATABASE_URL);
const [q] = await sql`SELECT * FROM group_function_quotes WHERE id = 10`;
const gcId = JSON.parse(q.square_gift_card_id)[0];

const ar = await fetch(
  `${SQUARE_BASE}/gift-cards/activities?gift_card_id=${encodeURIComponent(gcId)}`,
  { headers: H },
);
const ad = await ar.json().catch(() => ({}));
console.log("FULL gift card activity dump:");
for (const a of ad.gift_card_activities || []) {
  console.log(
    `\n--- ${a.type} @ ${a.created_at} (id=${a.id}) balance_after=$${((a.gift_card_balance_money?.amount ?? 0) / 100).toFixed(2)} ---`,
  );
  console.log(j(a));
}
