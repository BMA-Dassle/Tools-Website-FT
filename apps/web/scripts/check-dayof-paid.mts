/** Read-only: inspect the CANCELED payment blocking H2821 + current card balances. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const headers = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-08-21",
};
const SQ = "https://connect.squareup.com/v2";

const pRes = await fetch(`${SQ}/payments/tWwIubc7Rc3w56PGNIRwdTn0PgVZY`, { headers });
const pJson = (await pRes.json()) as { payment?: Record<string, unknown> };
const p = pJson.payment;
console.log(
  "canceled payment:",
  JSON.stringify(
    p && {
      id: p.id,
      status: p.status,
      amount: p.amount_money,
      source: p.source_type,
      location: p.location_id,
      order: p.order_id,
      created: p.created_at,
      delayAction: p.delay_action,
      capabilities: undefined,
    },
    null,
    2,
  ),
);

for (const gan of ["7783324111610376", "7783326805700470"]) {
  const res = await fetch(`${SQ}/gift-cards/from-gan`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ gan }),
  });
  const j = (await res.json()) as { gift_card?: { state?: string; balance_money?: unknown } };
  console.log(`card ${gan}: state=${j.gift_card?.state} balance=${JSON.stringify(j.gift_card?.balance_money)}`);
}
process.exit(0);
