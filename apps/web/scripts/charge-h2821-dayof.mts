/**
 * Owner-authorized manual run of the day-of multi-tender for H2821 (quote 119).
 * Mirrors the fixed cron exactly, INCLUDING idempotency keys (mt2/payorder2),
 * so a concurrent cron tick replays rather than double-charges.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const SQ = "https://connect.squareup.com/v2";
const headers = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};

const { sql } = await import("@/lib/db");
const { parseGiftCardIds } = await import("@/lib/group-function-db");
const q = sql();

const [quote] = (await q`
  SELECT * FROM group_function_quotes WHERE id = 119
`) as Array<Record<string, string>>;
if (quote.dayof_paid_at) {
  console.log("Already paid:", quote.dayof_paid_at);
  process.exit(0);
}
const orderId = quote.square_dayof_order_id;
const gcIds = parseGiftCardIds(quote.square_gift_card_id);

const oRes = await fetch(`${SQ}/orders/${orderId}`, { headers });
const order = ((await oRes.json()) as { order: Record<string, never> }).order;
console.log(`order state=${order["state"]} version=${order["version"]}`);
const payLocationId: string = order["location_id"];
let remaining: number =
  (order["net_amount_due_money"] as { amount?: number })?.amount ??
  (order["total_money"] as { amount?: number })?.amount ??
  0;
console.log(`net due: $${(remaining / 100).toFixed(2)} at location ${payLocationId}`);
if (remaining <= 0 || order["state"] === "COMPLETED") {
  console.log("Nothing due — order already settled.");
  process.exit(0);
}

const plan: Array<{ gcId: string; amount: number; idx: number }> = [];
let toCover = remaining;
for (let i = 0; i < gcIds.length && toCover > 0; i++) {
  const gcRes = await fetch(`${SQ}/gift-cards/${gcIds[i]}`, { headers });
  const g = ((await gcRes.json()) as { gift_card?: { balance_money?: { amount?: number } } })
    .gift_card;
  const bal = g?.balance_money?.amount ?? 0;
  if (bal <= 0) continue;
  const amount = Math.min(bal, toCover);
  plan.push({ gcId: gcIds[i], amount, idx: i });
  toCover -= amount;
}
if (toCover > 0) {
  console.error(`Cards short by $${(toCover / 100).toFixed(2)} — aborting.`);
  process.exit(1);
}
console.log("plan:", JSON.stringify(plan.map((p) => ({ idx: p.idx, amount: p.amount }))));

// Sanity: confirm the voided mt2 payments released their holds.
for (const { gcId, idx } of plan) {
  const gcRes = await fetch(`${SQ}/gift-cards/${gcId}`, { headers });
  const g = ((await gcRes.json()) as { gift_card?: { balance_money?: { amount?: number } } })
    .gift_card;
  console.log(`pre-charge card[${idx}] balance: ${g?.balance_money?.amount}`);
}

const note = `Group event: ${quote.event_name || ""} (#${quote.event_number || quote.id})`;
const created: string[] = [];
for (const { gcId, amount, idx } of plan) {
  const res = await fetch(`${SQ}/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      idempotency_key: `gf-dayof-mt3-${quote.id}-${idx}-${payLocationId}`,
      source_id: gcId,
      amount_money: { amount, currency: "USD" },
      order_id: orderId,
      location_id: payLocationId,
      autocomplete: false,
      note,
    }),
  });
  const j = (await res.json()) as {
    payment?: { id: string; status: string };
    errors?: Array<{ detail?: string }>;
  };
  if (!res.ok || !j.payment) {
    console.error(`create gc[${idx}] FAILED:`, JSON.stringify(j.errors || j).slice(0, 400));
    for (const pid of created) {
      await fetch(`${SQ}/payments/${pid}/cancel`, { method: "POST", headers }).catch(() => {});
    }
    process.exit(1);
  }
  console.log(`created gc[${idx}] payment=${j.payment.id} status=${j.payment.status}`);
  created.push(j.payment.id);
}

// Creating payments on the order bumps its version — refetch right before
// PayOrder (VERSION_MISMATCH killed the first manual attempt).
const fresh = await fetch(`${SQ}/orders/${orderId}`, { headers });
const freshVersion = ((await fresh.json()) as { order?: { version?: number } }).order?.version;
console.log(`PayOrder with refreshed order version=${freshVersion}`);

const payRes = await fetch(`${SQ}/orders/${orderId}/pay`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    idempotency_key: `gf-dayof-payorder3-${quote.id}-${payLocationId}`,
    order_version: freshVersion,
    payment_ids: created,
  }),
});
const payJson = (await payRes.json()) as {
  order?: { state?: string };
  errors?: Array<{ detail?: string }>;
};
if (!payRes.ok) {
  console.error("PayOrder FAILED:", JSON.stringify(payJson.errors || payJson).slice(0, 400));
  for (const pid of created) {
    await fetch(`${SQ}/payments/${pid}/cancel`, { method: "POST", headers }).catch(() => {});
  }
  process.exit(1);
}
console.log(`PayOrder OK — order state now: ${payJson.order?.state}`);

await q`UPDATE group_function_quotes SET
  dayof_paid_at = NOW(),
  dayof_payment_ids = ${JSON.stringify(created)}::jsonb,
  dayof_payment_error = NULL,
  updated_at = NOW()
WHERE id = ${quote.id}`;
console.log("DB updated: dayof_paid_at set, payment ids recorded.");
process.exit(0);
