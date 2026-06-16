/**
 * $0 live probe — proves the ONE new mechanic the gift-card-sale deposit flow
 * relies on: a DIGITAL gift card created with a CUSTOM GAN, then ACTIVATEd via
 * `order_id` + `line_item_uid` against a GIFT_CARD line item.
 *
 * `mintDigitalGiftCard` already proves order-linked ACTIVATE in prod, but with
 * an AUTO gan; the deposit flow needs a CUSTOM gan (so isInternalDepositGan can
 * keep blocking these cards from customer tender). This script confirms the two
 * combine, at $0 cost: a 100% catalog discount zeroes the order (the same comp
 * trick mintDigitalGiftCard uses), so no real money moves. The card is cleared
 * + deactivated at the end so no liability is left behind.
 *
 * Run:  npx tsx apps/web/scripts/deposit-giftcard-probe.mts
 * Needs SQUARE_ACCESS_TOKEN in the environment (.env.local works locally).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

// Load .env.local the same way the other scripts do (tsx doesn't auto-load it).
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {
  // No .env.local — rely on the ambient environment.
}

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;

// Naples location + the existing legacy-deposit comp discount (100% off) used
// by mintDigitalGiftCard's $0 mint path.
const LOCATION_ID = process.env.PROBE_LOCATION_ID || "PPTR5G2N0QXF7";
const DISCOUNT_ID = process.env.SQUARE_LEGACY_DEPOSIT_DISCOUNT_ID || "RN4EW6G4KYCGZ3HYI4AHMZSB";
const AMOUNT_CENTS = 100; // $1 gross; netted to $0 by the discount

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

async function sq(path: string, method: string, body?: unknown) {
  const res = await fetch(`${SQUARE_BASE}${path}`, {
    method,
    headers: headers(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !data.errors, status: res.status, data };
}

function fail(step: string, r: { status: number; data: unknown }): never {
  console.error(`\n❌ FAIL at "${step}" (HTTP ${r.status})`);
  console.error(JSON.stringify(r.data, null, 2));
  process.exit(1);
}

async function main() {
  if (!TOKEN) {
    console.error("SQUARE_ACCESS_TOKEN is not set. Add it to the env (.env.local) and retry.");
    process.exit(1);
  }

  const base = randomBytes(6).toString("hex");
  const customGan = `PROBE${base.slice(0, 8).toUpperCase()}`; // 13 chars, in [8,20]
  console.log(`Probe base=${base}  customGan=${customGan}  location=${LOCATION_ID}`);

  // 1. GIFT_CARD-line order, zeroed by a 100% catalog discount → $0 to pay.
  const order = await sq("/orders", "POST", {
    idempotency_key: `probe-order-${base}`,
    order: {
      location_id: LOCATION_ID,
      line_items: [
        {
          name: "Reservation Deposit (PROBE)",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: AMOUNT_CENTS, currency: "USD" },
        },
      ],
      discounts: [{ catalog_object_id: DISCOUNT_ID }],
    },
  });
  if (!order.ok) fail("create order", order);
  const orderId = order.data.order?.id;
  const lineItemUid = order.data.order?.line_items?.[0]?.uid;
  const grossSales = order.data.order?.line_items?.[0]?.gross_sales_money?.amount;
  console.log(`✓ order ${orderId}  line_item ${lineItemUid}  gross_sales=${grossSales}`);
  if (!orderId || !lineItemUid) fail("order missing id/uid", order);

  // 2. Pay the $0 order (discount covered it).
  const pay = await sq(`/orders/${orderId}/pay`, "POST", {
    idempotency_key: `probe-pay-${base}`,
    payment_ids: [],
  });
  if (!pay.ok) fail("pay $0 order", pay);
  console.log("✓ $0 order paid");

  // 3. Create a DIGITAL gift card with the CUSTOM GAN — the key combination.
  const create = await sq("/gift-cards", "POST", {
    idempotency_key: `probe-gc-${base}`,
    location_id: LOCATION_ID,
    gift_card: { type: "DIGITAL", gan_source: "OTHER", gan: customGan },
  });
  if (!create.ok) fail("create custom-GAN gift card", create);
  const giftCardId = create.data.gift_card?.id;
  const gan = create.data.gift_card?.gan;
  console.log(`✓ gift card ${giftCardId}  gan=${gan}`);
  if (gan !== customGan) {
    console.error(`❌ FAIL: requested custom GAN ${customGan} but Square returned ${gan}`);
    process.exit(1);
  }

  // 4. ACTIVATE via order_id + line_item_uid (NO amount_money).
  const activate = await sq("/gift-cards/activities", "POST", {
    idempotency_key: `probe-act-${base}`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: LOCATION_ID,
      gift_card_id: giftCardId,
      activate_activity_details: { order_id: orderId, line_item_uid: lineItemUid },
    },
  });
  if (!activate.ok) fail("order-linked ACTIVATE (custom GAN)", activate);
  const activatedBalance = activate.data.gift_card_activity?.gift_card_balance_money?.amount;
  console.log(`✓ order-linked ACTIVATE succeeded  balance=${activatedBalance}`);

  // 5. Verify ACTIVE + correct balance ($1 gross, despite the comp discount).
  const verify = await sq(`/gift-cards/${giftCardId}`, "GET");
  if (!verify.ok) fail("verify gift card", verify);
  const state = verify.data.gift_card?.state;
  const balance = verify.data.gift_card?.balance_money?.amount;
  console.log(`✓ verify: state=${state} balance=${balance} gan=${verify.data.gift_card?.gan}`);
  const pass = state === "ACTIVE" && balance === AMOUNT_CENTS && verify.data.gift_card?.gan === customGan;

  // 6. Cleanup — zero the balance and deactivate so no liability lingers.
  await sq("/gift-cards/activities", "POST", {
    idempotency_key: `probe-clear-${base}`,
    gift_card_activity: {
      type: "CLEAR_BALANCE",
      location_id: LOCATION_ID,
      gift_card_id: giftCardId,
      clear_balance_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
    },
  });
  await sq("/gift-cards/activities", "POST", {
    idempotency_key: `probe-deact-${base}`,
    gift_card_activity: {
      type: "DEACTIVATE",
      location_id: LOCATION_ID,
      gift_card_id: giftCardId,
      deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
    },
  });
  console.log("✓ cleanup: balance cleared + card deactivated");

  if (pass) {
    console.log(
      "\n✅ PASS — custom GAN + order-linked ACTIVATE works. The deposit gift-card-sale flow is sound.",
    );
    process.exit(0);
  }
  console.error("\n❌ FAIL — card did not end ACTIVE with the expected balance/GAN.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Probe threw:", err);
  process.exit(1);
});
