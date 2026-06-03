/**
 * Find group function quotes with deposit paid but missing day-of Square order,
 * then create the orders and update the DB.
 *
 * Usage:
 *   node apps/web/scripts/check-missing-dayof.mjs          # dry-run (list only)
 *   node apps/web/scripts/check-missing-dayof.mjs --fix     # create orders + update DB
 *
 * Requires: DATABASE_URL, SQUARE_ACCESS_TOKEN env vars
 */
import { neon } from "@neondatabase/serverless";
import { randomBytes } from "crypto";

const DATABASE_URL = process.env.DATABASE_URL;
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";
const fix = process.argv.includes("--fix");

if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
if (fix && !SQUARE_TOKEN) {
  console.error("SQUARE_ACCESS_TOKEN required for --fix");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const rows = await sql`
  SELECT id, event_name, event_number, contract_short_id, center_code,
         square_location_id, event_date, status, total_cents, tax_cents,
         deposit_due_cents, balance_cents, deposit_paid_at,
         square_dayof_order_id, square_deposit_order_id,
         square_gift_card_gan, line_items, bmi_reservation_id
  FROM group_function_quotes
  WHERE deposit_paid_at IS NOT NULL
    AND (square_dayof_order_id IS NULL OR square_dayof_order_id = '')
    AND status NOT IN ('cancelled', 'denied')
  ORDER BY event_date ASC
`;

if (!rows.length) {
  console.log("All deposit-paid quotes have day-of orders. Nothing to backfill.");
  process.exit(0);
}

console.log(`Found ${rows.length} quote(s) missing day-of Square order:\n`);

for (const r of rows) {
  console.log(`  ${r.event_name} #${r.event_number || "?"}`);
  console.log(`    shortId:  ${r.contract_short_id}`);
  console.log(`    center:   ${r.center_code} (location: ${r.square_location_id})`);
  console.log(`    date:     ${r.event_date}`);
  console.log(`    status:   ${r.status}`);
  console.log(`    total:    $${(r.total_cents / 100).toFixed(2)}`);
  console.log(`    deposit:  $${(r.deposit_due_cents / 100).toFixed(2)}`);
  console.log(`    balance:  $${(r.balance_cents / 100).toFixed(2)}`);
  console.log(`    GAN:      ${r.square_gift_card_gan}`);

  if (!fix) {
    console.log(`    [dry-run] pass --fix to create order\n`);
    continue;
  }

  const rawItems = r.line_items || [];
  if (!rawItems.length) {
    console.log(`    [SKIP] no line items\n`);
    continue;
  }

  const baseKey = randomBytes(8).toString("hex");
  const refId = `GF-${r.event_number || r.bmi_reservation_id}`.slice(0, 40);
  const serviceCharges =
    r.tax_cents > 0
      ? [
          {
            name: "Service Charge",
            amount_money: { amount: r.tax_cents, currency: "USD" },
            calculation_phase: "SUBTOTAL_PHASE",
          },
        ]
      : [];

  const sqHeaders = {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };

  let dayofOrderId;

  // Attempt 1: catalog-linked
  try {
    const lineItems = rawItems.map((p) => {
      if (p.plu && p.plu.length > 10) {
        return { catalog_object_id: p.plu, quantity: String(p.qty) };
      }
      return {
        name: p.name,
        quantity: String(p.qty),
        base_price_money: { amount: Math.round(p.price * 100), currency: "USD" },
      };
    });
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders,
      body: JSON.stringify({
        idempotency_key: `gf-dayof-backfill-${baseKey}`,
        order: {
          location_id: r.square_location_id,
          reference_id: refId,
          line_items: lineItems,
          ...(serviceCharges.length ? { service_charges: serviceCharges } : {}),
        },
      }),
    });
    const data = await res.json();
    if (res.ok && data.order?.id) {
      dayofOrderId = data.order.id;
    } else {
      console.log(`    catalog order failed, trying ad-hoc...`);
    }
  } catch (err) {
    console.log(`    catalog order error: ${err.message}, trying ad-hoc...`);
  }

  // Attempt 2: ad-hoc
  if (!dayofOrderId) {
    const adHocItems = rawItems.map((p) => ({
      name: p.name,
      quantity: String(p.qty),
      base_price_money: { amount: Math.round(p.price * 100), currency: "USD" },
    }));
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders,
      body: JSON.stringify({
        idempotency_key: `gf-dayof-backfill-adhoc-${baseKey}`,
        order: {
          location_id: r.square_location_id,
          reference_id: refId,
          line_items: adHocItems,
          ...(serviceCharges.length ? { service_charges: serviceCharges } : {}),
        },
      }),
    });
    const data = await res.json();
    if (res.ok && data.order?.id) {
      dayofOrderId = data.order.id;
    } else {
      console.log(`    [FAIL] ad-hoc order also failed: ${JSON.stringify(data).slice(0, 200)}\n`);
      continue;
    }
  }

  // Update DB
  await sql`
    UPDATE group_function_quotes
    SET square_dayof_order_id = ${dayofOrderId}, updated_at = NOW()
    WHERE id = ${r.id}
  `;
  console.log(`    [OK] created order ${dayofOrderId}\n`);
}

if (!fix) {
  console.log("Run with --fix to create missing day-of orders.");
}
