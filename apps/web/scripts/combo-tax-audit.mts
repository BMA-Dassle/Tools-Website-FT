/**
 * READ-ONLY tax audit for group-function (pre-paid event) quotes.
 *
 * Recomputes tax from each quote's stored line_items (rate × line-total) and
 * compares against the stored tax_cents / total_cents. Flags:
 *   - non-exempt quotes with tax_cents == 0
 *   - quotes where stored tax_cents disagrees with recomputed tax
 *   - quotes whose line_items carry no tax rate at all (all p.tax falsy)
 *   - day-of order implications (tax is added as a service charge ONLY when tax_cents > 0)
 *
 * No writes. Usage: node --env-file=apps/web/.env.local apps/web/scripts/combo-tax-audit.mts
 */
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (run with --env-file=apps/web/.env.local)");
  process.exit(1);
}
const sql = neon(DATABASE_URL);

function isTaxExemptProducts(products: any[]): boolean {
  return products.some((p) => p?.name === "GF Tax Exempt");
}
function subtotalCents(products: any[]): number {
  return Math.round(products.reduce((s, p) => s + (p.total || 0), 0) * 100);
}
function taxCents(products: any[], exempt: boolean): number {
  if (exempt) return 0;
  return Math.round(products.reduce((s, p) => s + (p.tax || 0) * (p.total || 0), 0) * 100);
}

const rows = (await sql`
  SELECT id, event_name, event_number, contract_short_id, center_code,
         event_date, status, total_cents, tax_cents, deposit_due_cents,
         balance_cents, deposit_paid_at, is_tax_exempt,
         square_dayof_order_id, line_items, bmi_reservation_id, created_at
  FROM group_function_quotes
  WHERE status NOT IN ('cancelled', 'denied', 'expired')
  ORDER BY event_date DESC
`) as any[];

console.log(`Scanned ${rows.length} active group-function quotes.\n`);

const flagged: any[] = [];

for (const r of rows) {
  const products = (r.line_items || []) as any[];
  if (!products.length) continue;

  const exempt = r.is_tax_exempt || isTaxExemptProducts(products);
  const sub = subtotalCents(products);
  const correctTax = taxCents(products, exempt);
  const correctTotal = sub + correctTax;

  const anyTaxRate = products.some((p) => (p.tax || 0) > 0);
  const allTaxRatesZero = !anyTaxRate && !exempt;

  const taxMismatch = r.tax_cents !== correctTax;
  const totalMismatch = r.total_cents !== correctTotal;
  const nonExemptZeroTax = !exempt && (r.tax_cents || 0) === 0;
  const dayofWouldHaveNoTax = (r.tax_cents || 0) === 0 && !exempt;

  if (taxMismatch || totalMismatch || nonExemptZeroTax || allTaxRatesZero) {
    flagged.push({
      id: r.id,
      event: `${r.event_name} #${r.event_number || "?"}`,
      center: r.center_code,
      date: r.event_date,
      status: r.status,
      paid: !!r.deposit_paid_at,
      exempt,
      storedTax: r.tax_cents,
      correctTax,
      storedTotal: r.total_cents,
      correctTotal,
      deposit: r.deposit_due_cents,
      shortfallCents: correctTotal - r.total_cents,
      allTaxRatesZero,
      dayofWouldHaveNoTax,
      hasDayof: !!r.square_dayof_order_id,
      createdAt: r.created_at,
    });
  }
}

console.log(`FLAGGED: ${flagged.length}\n`);
for (const f of flagged) {
  console.log(`#${f.id} ${f.event} [${f.center}] ${f.status}${f.paid ? " PAID" : " unpaid"}`);
  console.log(`   eventDate=${f.date}  created=${f.createdAt}`);
  console.log(
    `   storedTax=$${(f.storedTax / 100).toFixed(2)} correctTax=$${(f.correctTax / 100).toFixed(2)}` +
      `  storedTotal=$${(f.storedTotal / 100).toFixed(2)} correctTotal=$${(f.correctTotal / 100).toFixed(2)}`,
  );
  console.log(
    `   deposit=$${(f.deposit / 100).toFixed(2)} shortfall=$${(f.shortfallCents / 100).toFixed(2)}` +
      ` exempt=${f.exempt} allTaxRatesZero=${f.allTaxRatesZero} dayofWouldHaveNoTax=${f.dayofWouldHaveNoTax} hasDayof=${f.hasDayof}`,
  );
  console.log("");
}

// Summary buckets
const paidShortfall = flagged.filter((f) => f.paid && f.shortfallCents > 0);
const unpaidWrong = flagged.filter((f) => !f.paid && (f.shortfallCents !== 0 || f.storedTax !== f.correctTax));
const noRateAtAll = flagged.filter((f) => f.allTaxRatesZero);
console.log("── SUMMARY ──");
console.log(`Paid quotes under-collected (shortfall>0): ${paidShortfall.length}, total $${(paidShortfall.reduce((s, f) => s + f.shortfallCents, 0) / 100).toFixed(2)}`);
console.log(`Unpaid quotes with wrong tax/total: ${unpaidWrong.length}`);
console.log(`Quotes whose line_items carry NO tax rate at all (non-exempt): ${noRateAtAll.length}`);
