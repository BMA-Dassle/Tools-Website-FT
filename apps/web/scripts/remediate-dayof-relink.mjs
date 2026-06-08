// Remediate OPEN/unpaid day-of Square orders that carry ad-hoc line items: rebuild
// them fully catalog-linked (link + base_price_money, mirroring the fixed
// buildSquareLineItem), repoint the quote at the new order, and cancel the stale one.
//
//   node apps/web/scripts/remediate-dayof-relink.mjs           # DRY-RUN (validates via /calculate)
//   node apps/web/scripts/remediate-dayof-relink.mjs --apply   # create new orders, repoint DB, cancel old
//
// Only touches OPEN orders. Refuses to touch COMPLETED/paid orders.
import fs from "fs";
import { neon } from "@neondatabase/serverless";
import { randomBytes } from "crypto";

const env = fs.readFileSync("c:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const tok = env
  .match(/^SQUARE_ACCESS_TOKEN=(.+)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const sql = neon(
  "postgresql://neondb_owner:npg_j2dvUJEB0STo@ep-odd-frog-am0i4stu-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require",
);
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${tok}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const d = (c) => `$${((c || 0) / 100).toFixed(2)}`;
const apply = process.argv.includes("--apply");

// The 5 OPEN/future events flagged by the audit. (Completed/paid past events excluded.)
const QUOTE_IDS = [19, 121, 39, 130, 105];

// Mirror of the fixed buildSquareLineItem: link when PLU present, always send price.
function buildLine(p) {
  const base = {
    quantity: String(p.qty),
    base_price_money: { amount: Math.round(p.price * 100), currency: "USD" },
  };
  return p.plu && p.plu.length > 10
    ? { catalog_object_id: p.plu, ...base }
    : { name: p.name, ...base };
}

let allGood = true;
for (const qid of QUOTE_IDS) {
  const [q] = await sql`SELECT * FROM group_function_quotes WHERE id=${qid}`;
  const li = typeof q.line_items === "string" ? JSON.parse(q.line_items) : q.line_items;
  const oldOrder = (
    await (await fetch(`${BASE}/orders/${q.square_dayof_order_id}`, { headers: H })).json()
  ).order;

  console.log(
    `\n[q${qid}] #${q.event_number} ${q.event_name} — ${q.center_code}  status=${q.status}`,
  );
  if (!oldOrder) {
    console.log(`   !! could not load existing order ${q.square_dayof_order_id} — SKIP`);
    allGood = false;
    continue;
  }
  if (oldOrder.state !== "OPEN") {
    console.log(`   !! existing order state=${oldOrder.state} (not OPEN) — REFUSING to touch`);
    allGood = false;
    continue;
  }

  const oldLinked = (oldOrder.line_items || []).filter((x) => x.catalog_object_id).length;
  const oldTotal = oldOrder.total_money?.amount || 0;

  const serviceCharges =
    q.tax_cents > 0
      ? [
          {
            name: "Service Charge",
            amount_money: { amount: q.tax_cents, currency: "USD" },
            calculation_phase: "SUBTOTAL_PHASE",
          },
        ]
      : [];
  const lineItems = li.map(buildLine);
  const orderBody = {
    location_id: q.square_location_id,
    reference_id: `GF-${q.event_number || q.bmi_reservation_id}`.slice(0, 40),
    line_items: lineItems,
    service_charges: serviceCharges.length ? serviceCharges : undefined,
  };

  // Validate the rebuilt order BEFORE creating anything.
  const calc = await (
    await fetch(`${BASE}/orders/calculate`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ order: orderBody }),
    })
  ).json();
  const newTotal = calc.order?.total_money?.amount || 0;
  const newLinked = (calc.order?.line_items || []).filter((x) => x.catalog_object_id).length;
  const newCount = (calc.order?.line_items || []).length;

  const oldCount = (oldOrder.line_items || []).length;
  // Source of truth is the QUOTE. The rebuilt order must equal quote.total_cents.
  const matchesQuote = newTotal === q.total_cents;
  const stale = newTotal !== oldTotal; // existing order disagrees with the current quote
  const alreadyClean = oldLinked === oldCount && !stale;

  console.log(
    `   existing order ${q.square_dayof_order_id}: ${oldLinked}/${oldCount} linked, total ${d(oldTotal)}`,
  );
  console.log(
    `   rebuilt (calculated): ${newLinked}/${newCount} linked, total ${d(newTotal)}  quote total_cents ${d(q.total_cents)}`,
  );
  console.log(`   matches quote: ${matchesQuote ? "YES ✓" : "NO ✗  *** WILL NOT APPLY ***"}`);
  if (stale)
    console.log(
      `   ⚠ existing order is STALE vs quote: ${d(oldTotal)} → ${d(newTotal)} (corrects a ${d(Math.abs(oldTotal - newTotal))} drift; balance was already recomputed against the quote)`,
    );
  if (!matchesQuote) {
    allGood = false;
    continue;
  }
  if (alreadyClean) {
    console.log(`   already fully linked & matches quote — nothing to do`);
    continue;
  }

  if (!apply) {
    console.log(
      `   [dry-run] would create new linked order, repoint q${qid}, cancel ${q.square_dayof_order_id}`,
    );
    continue;
  }

  // --- APPLY ---
  const key = randomBytes(8).toString("hex");
  const createRes = await fetch(`${BASE}/orders`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ idempotency_key: `gf-dayof-relink-${key}`, order: orderBody }),
  });
  const created = await createRes.json();
  if (!createRes.ok || !created.order?.id) {
    console.log(`   !! create failed: ${JSON.stringify(created.errors || created).slice(0, 200)}`);
    allGood = false;
    continue;
  }
  const newId = created.order.id;
  if ((created.order.total_money?.amount || 0) !== q.total_cents) {
    console.log(
      `   !! created order total ${d(created.order.total_money?.amount)} != quote ${d(q.total_cents)} — NOT repointing, leaving as is`,
    );
    allGood = false;
    continue;
  }

  await sql`UPDATE group_function_quotes SET square_dayof_order_id=${newId}, updated_at=NOW() WHERE id=${qid}`;
  console.log(`   ✓ created ${newId} (${newLinked}/${newCount} linked) and repointed q${qid}`);

  // Cancel the stale old order.
  const cancelRes = await fetch(`${BASE}/orders/${q.square_dayof_order_id}`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({
      order: { version: oldOrder.version, state: "CANCELED" },
      idempotency_key: `gf-dayof-cancel-${key}`,
    }),
  });
  console.log(
    cancelRes.ok
      ? `   ✓ canceled old order ${q.square_dayof_order_id}`
      : `   ⚠ could not cancel old order (left OPEN, no longer referenced): ${cancelRes.status}`,
  );
}

console.log(
  `\n${apply ? "APPLY" : "DRY-RUN"} complete. ${allGood ? "All targets validated." : "Some targets failed validation — review above."}`,
);
if (!apply) console.log("Re-run with --apply to execute.");
