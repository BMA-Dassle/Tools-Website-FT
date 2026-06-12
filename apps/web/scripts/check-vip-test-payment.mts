/** What was ACTUALLY charged for the W40311 Ultimate VIP test (~01:10Z 6/12)?
 *  Lists payments at HP FM in the window + the gift card balance, to compare
 *  displayed $82.87 vs day-of order total $83.06. Read-only. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const pay = await fetch(
  "https://connect.squareup.com/v2/payments?location_id=TXBSQN0FEKQ11&begin_time=2026-06-12T01:00:00Z&end_time=2026-06-12T01:20:00Z&sort_order=ASC",
  { headers: H },
);
const payData = (await pay.json()) as {
  payments?: Array<{
    id: string;
    created_at: string;
    amount_money: { amount: number };
    status: string;
    order_id?: string;
    note?: string;
  }>;
};
console.log("Payments at HP FM 01:00–01:20Z:");
for (const p of payData.payments ?? []) {
  console.log(
    `  ${p.created_at}  $${(p.amount_money.amount / 100).toFixed(2)}  ${p.status}  order=${p.order_id ?? "—"}  note=${p.note ?? ""}`,
  );
}

// Gift cards created in the window — check the loaded balance.
const gc = await fetch("https://connect.squareup.com/v2/gift-cards?limit=10", { headers: H });
const gcData = (await gc.json()) as {
  gift_cards?: Array<{
    id: string;
    created_at: string;
    balance_money?: { amount: number };
    state: string;
  }>;
};
console.log("\nNewest gift cards:");
for (const g of (gcData.gift_cards ?? []).filter((g) => g.created_at >= "2026-06-12T00:50:00Z")) {
  console.log(
    `  ${g.created_at}  ${g.id}  balance=$${((g.balance_money?.amount ?? 0) / 100).toFixed(2)}  ${g.state}`,
  );
}
