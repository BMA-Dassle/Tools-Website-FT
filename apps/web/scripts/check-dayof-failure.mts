/**
 * Read-only diagnostics for a failing group-dayof-pay quote: Square gift-card
 * balances/states + day-of order state, plus the quote row for a second id.
 * Usage (from apps/web): npx tsx scripts/check-dayof-failure.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const SQ = "https://connect.squareup.com/v2";
const headers = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-08-21",
};

async function giftCardByGan(gan: string) {
  const res = await fetch(`${SQ}/gift-cards/from-gan`, {
    method: "POST",
    headers,
    body: JSON.stringify({ gan }),
  });
  const j = (await res.json()) as { gift_card?: Record<string, unknown>; errors?: unknown };
  const g = j.gift_card;
  return g
    ? { gan, state: g.state, balance: g.balance_money, type: g.type }
    : { gan, errors: j.errors };
}

async function order(orderId: string) {
  const res = await fetch(`${SQ}/orders/${orderId}`, { headers });
  const j = (await res.json()) as { order?: Record<string, unknown>; errors?: unknown };
  const o = j.order;
  if (!o) return { orderId, errors: j.errors };
  const tenders = (o.tenders as Array<Record<string, unknown>> | undefined)?.map((t) => ({
    type: t.type,
    amount: t.amount_money,
    cardDetails: t.card_details ? "card" : undefined,
  }));
  return {
    orderId,
    state: o.state,
    total: o.total_money,
    netDue: o.net_amount_due_money,
    tenders,
  };
}

console.log("=== H2821 gift cards ===");
console.log(JSON.stringify(await giftCardByGan("7783324111610376"), null, 2));
console.log(JSON.stringify(await giftCardByGan("7783326805700470"), null, 2));
console.log("=== H2821 day-of order ===");
console.log(JSON.stringify(await order("lYfNfPosK9chi9noX290jWaxrGVZY"), null, 2));

const { sql } = await import("@/lib/db");
const q = sql();
const rows = (await q`
  SELECT id, event_number, event_name, status, event_date, dayof_paid_at,
         dayof_payment_error, square_dayof_order_id, square_gift_card_gan,
         total_cents, collected_cents
  FROM group_function_quotes WHERE id = 128
`) as Array<Record<string, unknown>>;
console.log("=== quote 128 ===");
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
