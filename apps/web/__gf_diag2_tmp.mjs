import { neon } from "@neondatabase/serverless";
const SQUARE_BASE = "https://connect.squareup.com/v2";
const TOK = process.env.SQUARE_ACCESS_TOKEN || "";
const H = {
  Authorization: `Bearer ${TOK}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const j = (o) => JSON.stringify(o, null, 2);
const sql = neon(process.env.DATABASE_URL);

const [q] = await sql`SELECT * FROM group_function_quotes WHERE id = 10`;
const gcId = JSON.parse(q.square_gift_card_id)[0];

// Gift card balance (parsed id)
const gr = await fetch(`${SQUARE_BASE}/gift-cards/${encodeURIComponent(gcId)}`, { headers: H });
const gd = await gr.json().catch(() => ({}));
console.log(`gift card ${gcId}: ${gr.status}`);
console.log(
  "  " +
    (gr.ok
      ? `gan=${gd.gift_card?.gan} state=${gd.gift_card?.state} balance=$${((gd.gift_card?.balance_money?.amount ?? 0) / 100).toFixed(2)}`
      : j(gd).slice(0, 300)),
);

// Deposit order — confirm deposit payment + understand customer linkage
if (q.square_deposit_order_id) {
  const or = await fetch(`${SQUARE_BASE}/orders/${q.square_deposit_order_id}`, { headers: H });
  const od = await or.json().catch(() => ({}));
  const o = od.order || {};
  console.log(
    `\ndeposit order ${q.square_deposit_order_id}: state=${o.state} total=$${((o.total_money?.amount ?? 0) / 100).toFixed(2)} due=$${((o.net_amount_due_money?.amount ?? 0) / 100).toFixed(2)}`,
  );
  for (const t of o.tenders || [])
    console.log(
      `  tender ${t.type} $${((t.amount_money?.amount ?? 0) / 100).toFixed(2)} payment=${t.payment_id}`,
    );
}

// Day-of order state
if (q.square_dayof_order_id) {
  const or = await fetch(`${SQUARE_BASE}/orders/${q.square_dayof_order_id}`, { headers: H });
  const od = await or.json().catch(() => ({}));
  const o = od.order || {};
  console.log(
    `\nday-of order ${q.square_dayof_order_id}: state=${o.state} total=$${((o.total_money?.amount ?? 0) / 100).toFixed(2)} due=$${((o.net_amount_due_money?.amount ?? 0) / 100).toFixed(2)}`,
  );
}

// Gift card activities — full history (deposit load, any balance load)
const ar = await fetch(
  `${SQUARE_BASE}/gift-cards/activities?gift_card_id=${encodeURIComponent(gcId)}`,
  { headers: H },
);
const ad = await ar.json().catch(() => ({}));
console.log(`\ngift card activities: ${ar.status}`);
for (const a of ad.gift_card_activities || []) {
  const amt =
    a.activate_activity_details?.amount_money?.amount ??
    a.load_activity_details?.amount_money?.amount ??
    a.redeem_activity_details?.amount_money?.amount ??
    0;
  console.log(
    `  ${a.created_at} ${a.type} $${(amt / 100).toFixed(2)} → bal $${((a.gift_card_balance_money?.amount ?? 0) / 100).toFixed(2)}`,
  );
}
