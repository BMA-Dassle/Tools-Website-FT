/**
 * SAFE probe: replay group-dayof-pay's CreatePayment calls with the SAME
 * idempotency key + SAME body the cron uses. Square replays the original
 * response (the original error) verbatim — no new payment can be created.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const headers = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-08-21",
};

const { sql } = await import("@/lib/db");
const { parseGiftCardIds } = await import("@/lib/group-function-db");
const q = sql();

async function probe(quoteId: number) {
  const [quote] = (await q`
    SELECT id, event_number, event_name, square_dayof_order_id, square_gift_card_id,
           square_location_id
    FROM group_function_quotes WHERE id = ${quoteId}
  `) as Array<Record<string, string>>;
  const orderId = quote.square_dayof_order_id;
  const gcIds = parseGiftCardIds(quote.square_gift_card_id);

  const oRes = await fetch(`https://connect.squareup.com/v2/orders/${orderId}`, { headers });
  const oJson = (await oRes.json()) as { order: Record<string, never> };
  const remaining: number =
    (oJson.order["net_amount_due_money"] as { amount?: number })?.amount ??
    (oJson.order["total_money"] as { amount?: number })?.amount ??
    0;

  const gcId = gcIds[0];
  const gRes = await fetch(`https://connect.squareup.com/v2/gift-cards/${gcId}`, { headers });
  const gJson = (await gRes.json()) as { gift_card: { balance_money?: { amount?: number } } };
  const gcBalance = gJson.gift_card?.balance_money?.amount ?? 0;
  const amountToPay = Math.min(gcBalance, remaining);

  const body = {
    idempotency_key: `gf-dayof-pay-${quote.id}-0`,
    source_id: gcId,
    amount_money: { amount: amountToPay, currency: "USD" },
    order_id: orderId,
    location_id: quote.square_location_id,
    autocomplete: true,
    note: `Group event: ${quote.event_name || ""} (#${quote.event_number || quote.id})`,
  };
  const res = await fetch("https://connect.squareup.com/v2/payments", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as Record<string, unknown>;
  console.log(`=== quote ${quoteId} (${quote.event_number}) gc[0] amount=${amountToPay} ===`);
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(j, null, 2).slice(0, 1500));
}

await probe(128);
await probe(119);
process.exit(0);
