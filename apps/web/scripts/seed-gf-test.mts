/**
 * Seed a TEST group-event quote so a GF deposit can be paid on the preview to
 * exercise the gift-card-sale flow — including the $2k-per-card chunking.
 *
 * Usage:  npx tsx scripts/seed-gf-test.mts [totalDollars]
 *   totalDollars default 4100 → 50% deposit = $2,050 → 2 gift cards
 *   ($2,000 + $50) → 2 GIFT_CARD line items on the deposit order.
 *
 * Sized so the day-of total == total_cents (tax_cents=0, no service charge),
 * which keeps the deposit route's displayed-vs-charged guard happy.
 *
 * Then open on the PREVIEW host:  /contract/<shortId>/pay
 * Cleanup:  DELETE FROM group_function_quotes WHERE contract_short_id = '<shortId>'
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const totalDollars = Number(process.argv[2] ?? 4100);
if (!Number.isFinite(totalDollars) || totalDollars <= 0) {
  console.error("totalDollars must be a positive number");
  process.exit(1);
}
const totalCents = Math.round(totalDollars * 100);
const depositDueCents = Math.round(totalCents / 2);

const rand = randomBytes(5).toString("hex");
const bmiReservationId = `TEST${rand.toUpperCase()}`; // unique, clearly test
const shortId = `gctest${rand.slice(0, 4)}`;
const lineItems = [
  {
    name: "Group Event (TEST — GC sale)",
    price: totalDollars,
    tax: 0,
    qty: 1,
    total: totalDollars,
    plu: "",
  },
];

const { sql } = await import("@/lib/db");
const q = sql();

const eventDate = new Date(Date.now() + 30 * 86_400_000).toISOString(); // ~30d out

await q`
  INSERT INTO group_function_quotes (
    bmi_reservation_id, center_code, center_name, square_location_id,
    guest_first_name, guest_last_name, guest_email,
    event_name, event_number, event_date,
    total_cents, tax_cents, deposit_due_cents, balance_cents,
    line_items, prior_payments,
    contract_short_id, contract_status, status,
    gan_prefix, base_url, is_tax_exempt
  ) VALUES (
    ${bmiReservationId}, 'fort-myers', 'HeadPinz Fort Myers', 'TXBSQN0FEKQ11',
    'Test', 'Booker', 'eric@headpinz.com',
    'TEST — GC Sale Chunking', ${`TEST-${rand}`}, ${eventDate},
    ${totalCents}, 0, ${depositDueCents}, ${totalCents - depositDueCents},
    ${JSON.stringify(lineItems)}::jsonb, '[]'::jsonb,
    ${shortId}, 'signed', 'contract_sent',
    'GRPF', 'https://fasttraxent.com', true
  )
`;

// Chunk plan (inlined so this script is independent of which branch the working
// tree is on — giftCardSaleChunks lives only on feat/deposit-giftcard-sale).
const GIFT_CARD_MAX_CENTS = 200_000;
const chunks: number[] = [];
for (let rem = depositDueCents; rem > 0; ) {
  const c = Math.min(rem, GIFT_CARD_MAX_CENTS);
  chunks.push(c);
  rem -= c;
}

console.log("✅ Seeded TEST group-event quote");
console.log(`   bmi_reservation_id : ${bmiReservationId}`);
console.log(`   contract_short_id  : ${shortId}`);
console.log(`   total              : $${(totalCents / 100).toFixed(2)}`);
console.log(`   deposit (50%)      : $${(depositDueCents / 100).toFixed(2)}`);
console.log(
  `   → ${chunks.length} gift card(s): ${chunks.map((c) => `$${(c / 100).toFixed(2)}`).join(" + ")}`,
);
console.log(`\nPay it on the preview:  /contract/${shortId}/pay`);
console.log(`Cleanup:  DELETE FROM group_function_quotes WHERE contract_short_id = '${shortId}';`);
process.exit(0);
