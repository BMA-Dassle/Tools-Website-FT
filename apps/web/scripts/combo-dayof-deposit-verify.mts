/**
 * READ-ONLY verification for the "deposit derived from day-of order total" change.
 *
 * For each deposit-paid quote that has a day-of Square order, GET the order and check:
 *   - the order carries tax (a service-charge / tax line), and its amount ≈ tax_cents
 *   - order.total_money.amount (what createDayofOrder now returns) ≈ quote.total_cents
 *   - the deposit charged ≈ (isFull ? orderTotal : orderTotal/2)
 *
 * Proves the new invariant holds retroactively. No writes; GET /orders only.
 *   node --env-file=apps/web/.env.local apps/web/scripts/combo-dayof-deposit-verify.mts
 */
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL!;
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";
if (!DATABASE_URL || !SQUARE_TOKEN) {
  console.error("Need DATABASE_URL + SQUARE_ACCESS_TOKEN (use --env-file=apps/web/.env.local)");
  process.exit(1);
}
const sql = neon(DATABASE_URL);
const d = (c: number) => `$${(c / 100).toFixed(2)}`;

const rows = (await sql`
  SELECT id, event_name, event_number, total_cents, tax_cents, deposit_due_cents,
         square_dayof_order_id
  FROM group_function_quotes
  WHERE deposit_paid_at IS NOT NULL
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
    AND deposit_due_cents > 0   -- post-paid/$0-deposit events never reach deposit derivation
    AND status NOT IN ('cancelled','denied','expired')
  ORDER BY event_date DESC
  LIMIT 25
`) as any[];

console.log(`Checking ${rows.length} paid quotes with a day-of order...\n`);
let okCount = 0;
const TOL = 50;

for (const r of rows) {
  // square_dayof_order_id may be a bare id or a JSON array of ids
  let orderId: string = r.square_dayof_order_id;
  try {
    const parsed = JSON.parse(r.square_dayof_order_id);
    if (Array.isArray(parsed) && parsed.length) orderId = parsed[0];
  } catch {
    /* bare id */
  }

  const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    headers: {
      Authorization: `Bearer ${SQUARE_TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    console.log(`#${r.id} ${r.event_name} — ⚠ order ${orderId} fetch ${res.status}`);
    continue;
  }
  const { order } = await res.json();
  const orderTotal = order?.total_money?.amount ?? 0;
  const scTotal = (order?.service_charges || []).reduce(
    (s: number, sc: any) => s + (sc.total_money?.amount ?? sc.amount_money?.amount ?? 0),
    0,
  );
  const isFull = r.deposit_due_cents >= r.total_cents;
  const impliedDeposit = isFull ? orderTotal : Math.round(orderTotal / 2);

  const totalOk = Math.abs(orderTotal - r.total_cents) <= TOL;
  const taxOk = Math.abs(scTotal - r.tax_cents) <= TOL || r.tax_cents === 0;
  const depOk = Math.abs(impliedDeposit - r.deposit_due_cents) <= TOL;
  if (totalOk && taxOk && depOk) okCount++;

  const flag = totalOk && taxOk && depOk ? "✓" : "✗";
  console.log(
    `${flag} #${r.id} ${r.event_name} #${r.event_number || "?"}\n` +
      `   orderTotal=${d(orderTotal)} vs quote.total=${d(r.total_cents)} ${totalOk ? "" : "  ⚠TOTAL"}\n` +
      `   order tax/SC=${d(scTotal)} vs tax_cents=${d(r.tax_cents)} ${taxOk ? "" : "  ⚠TAX"}\n` +
      `   impliedDeposit=${d(impliedDeposit)} vs deposit_due=${d(r.deposit_due_cents)} (full=${isFull}) ${depOk ? "" : "  ⚠DEPOSIT"}`,
  );
}
console.log(`\n${okCount}/${rows.length} consistent within ${d(TOL)}.`);
