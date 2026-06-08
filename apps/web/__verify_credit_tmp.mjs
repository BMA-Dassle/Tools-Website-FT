/**
 * Throwaway verify + teardown harness for the v2 race-credit redemption flow.
 *
 * Run from apps/web with the env file so it can reach Pandora / Square / Neon:
 *   node --env-file=.env.local __verify_credit_tmp.mjs <cmd> ...
 *
 * Commands:
 *   balance  <personId>
 *       Print the racer's live deposit balances (kind id + name + amount).
 *       Run it BEFORE you book and AGAIN after — the redeemed kind should drop
 *       by exactly the number of heats redeemed.
 *
 *   check    <billId>
 *       BMI bill overview (expect total depositKind 2 = 0) + the Neon
 *       bowling_reservations row + the Square day-of order (expect total 0c for a
 *       full credit redemption, i.e. no cash charged).
 *
 *   teardown <billId> <personId> <depositKindId> <count>
 *       Undo the test: restore <count> credit(s) of <depositKindId> to the racer,
 *       cancel the BMI bill, mark the Neon row cancelled. (A full redemption
 *       charges $0, so nothing to refund in Square; for a MIXED booking that DID
 *       charge cash, refund the day-of order from the Square dashboard.)
 *
 * Talks to the running dev server (http://localhost:3000) for BMI/Pandora calls,
 * and Neon/Square directly. Delete this file when done.
 */
import { neon } from "@neondatabase/serverless";

const BASE = process.env.VERIFY_BASE || "http://localhost:3000";
const LOC = "LAB52GY480CJF"; // FastTrax — race credits live on this ledger
const ADMIN_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";

const [cmd, ...args] = process.argv.slice(2);
const j = (o) => JSON.stringify(o, null, 2);

async function balance(personId) {
  if (!personId) return console.error("usage: balance <personId>");
  const r = await fetch(`${BASE}/api/pandora/deposits/${personId}?locationId=${LOC}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return console.error("balance error", r.status, j(d));
  console.log(`\nDeposit balances for person ${personId}:`);
  for (const row of d.data ?? [])
    console.log(`  [${row.OUT_DPK_ID}] ${row.OUT_DPK_NAME} = ${row.OUT_DPS_AMOUNT}`);
  if (!(d.data ?? []).length) console.log("  (no deposit rows)");
}

async function billOverview(billId) {
  const r = await fetch(`${BASE}/api/sms?endpoint=bill%2Foverview&billId=${billId}`);
  const text = await r.text();
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return console.error("bill overview non-JSON:", text.slice(0, 300));
  }
  console.log(`\nBMI bill overview ${billId}:`);
  console.log("  total   :", j(d.total));
  console.log("  subTotal:", j(d.subTotal));
  console.log("  totalTax:", j(d.totalTax));
  for (const l of d.lines ?? []) {
    const price = (l.totalPrice || []).map((p) => `dk${p.depositKind}:${p.amount}`).join(",");
    console.log(`    - ${l.name} x${l.quantity} [${price}] productId=${l.productId}`);
  }
}

async function neonRow(billId) {
  if (!process.env.DATABASE_URL) {
    console.log("(no DATABASE_URL — skipping Neon)");
    return null;
  }
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT id, status, product_kind, bmi_bill_id, square_dayof_order_id,
           square_deposit_payment_id, deposit_cents, total_cents
    FROM bowling_reservations
    WHERE bmi_bill_id = ${billId}
    ORDER BY id DESC`;
  console.log(`\nNeon bowling_reservations for bill ${billId}: ${rows.length} row(s)`);
  for (const row of rows) console.log("  " + j(row));
  return rows[0] ?? null;
}

async function squareOrder(orderId) {
  if (!orderId || !SQUARE_TOKEN) return;
  const r = await fetch(`https://connect.squareup.com/v2/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${SQUARE_TOKEN}`, "Square-Version": "2024-12-18" },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return console.error("square order error", r.status, j(d).slice(0, 300));
  const o = d.order || {};
  console.log(`\nSquare day-of order ${orderId}:`);
  console.log(
    `  state=${o.state} total=${o.total_money?.amount ?? 0}c tax=${o.total_tax_money?.amount ?? 0}c`,
  );
  for (const li of o.line_items ?? [])
    console.log(`    - ${li.name} x${li.quantity} = ${li.total_money?.amount ?? 0}c`);
}

async function check(billId) {
  if (!billId) return console.error("usage: check <billId>");
  await billOverview(billId);
  const row = await neonRow(billId);
  if (row?.square_dayof_order_id) await squareOrder(row.square_dayof_order_id);
  console.log(
    `\nFull redemption ⇒ BMI total dk2=0, Square order total 0c (no deposit charged), Neon status=confirmed product_kind=race.`,
  );
}

async function teardown(billId, personId, depositKindId, count) {
  if (!billId) return console.error("usage: teardown <billId> <personId> <depositKindId> <count>");
  const n = Number(count || 1);
  console.log(`\n== TEARDOWN bill ${billId} ==`);

  if (personId && depositKindId) {
    const r = await fetch(`${BASE}/api/pandora/deposit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pandora-internal": ADMIN_KEY,
        "x-pandora-caller": "credit-test-teardown",
      },
      body: JSON.stringify({ locationId: LOC, personId, depositKindId, amount: n }),
    });
    console.log(
      `restore +${n} credit (kind ${depositKindId}) → ${r.status} ${(await r.text()).slice(0, 200)}`,
    );
  } else {
    console.log("restore credit: skipped (pass personId depositKindId count to restore)");
  }

  const c = await fetch(`${BASE}/api/bmi?endpoint=bill%2F${billId}%2Fcancel`, { method: "DELETE" });
  console.log(`cancel BMI bill → ${c.status} ${(await c.text()).slice(0, 200)}`);

  if (process.env.DATABASE_URL) {
    const sql = neon(process.env.DATABASE_URL);
    const upd = await sql`
      UPDATE bowling_reservations SET status='cancelled'
      WHERE bmi_bill_id = ${billId} RETURNING id`;
    console.log(`Neon status=cancelled → ${upd.length} row(s)`);
  }
  console.log(
    `\nFull redemption charged $0 — nothing to refund. For a MIXED booking that charged cash, refund the day-of order in the Square dashboard.`,
  );
}

(async () => {
  if (cmd === "balance") await balance(args[0]);
  else if (cmd === "check") await check(args[0]);
  else if (cmd === "teardown") await teardown(args[0], args[1], args[2], args[3]);
  else
    console.log(
      `Usage:  node --env-file=.env.local __verify_credit_tmp.mjs <cmd>\n` +
        `  balance  <personId>\n` +
        `  check    <billId>\n` +
        `  teardown <billId> <personId> <depositKindId> <count>`,
    );
})();
