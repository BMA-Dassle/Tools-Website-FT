/**
 * Faithful local runner for the group-quote-tax-backfill route logic
 * (apps/web/app/api/cron/group-quote-tax-backfill/route.ts). Recomputes tax
 * from stored line_items for UNPAID, contract-ready quotes and updates the same
 * 4 financial columns. Paid quotes are report-only (never modified).
 *
 * Dry-run by default. Pass --apply to write.
 *   node --env-file=apps/web/.env.local apps/web/scripts/combo-tax-backfill-run.mts [--apply]
 */
import { neon } from "@neondatabase/serverless";

const APPLY = process.argv.includes("--apply");
const sql = neon(process.env.DATABASE_URL!);

// ── mirror of @/lib/group-function-pricing + isTaxExempt ──
const isExemptProducts = (ps: any[]) => ps.some((p) => p?.name === "GF Tax Exempt");
const subtotalCents = (ps: any[]) => Math.round(ps.reduce((s, p) => s + (p.total || 0), 0) * 100);
const taxCents = (ps: any[], exempt: boolean) =>
  exempt ? 0 : Math.round(ps.reduce((s, p) => s + (p.tax || 0) * (p.total || 0), 0) * 100);

function computeFinancials(quote: any, products: any[]) {
  const taxExempt = quote.is_tax_exempt || isExemptProducts(products);
  const tax = taxCents(products, taxExempt);
  const total = subtotalCents(products) + tax;
  const isPostPaid = products.some((p) => p.name === "GF Post Paid Account");
  const hoursUntilEvent = (new Date(quote.event_date).getTime() - Date.now()) / 3_600_000;
  const fullPaymentRequired = !isPostPaid && hoursUntilEvent <= 96;
  const deposit = isPostPaid ? 0 : fullPaymentRequired ? total : Math.round(total / 2);
  const balance = Math.max(0, total - deposit);
  return { tax_cents: tax, total_cents: total, deposit_due_cents: deposit, balance_cents: balance };
}

const d = (c: number) => `$${(c / 100).toFixed(2)}`;

const unpaid = (await sql`
  SELECT * FROM group_function_quotes
  WHERE deposit_paid_at IS NULL
    AND status IN ('pending', 'pending_approval', 'contract_sent', 'resign_required')
  ORDER BY id ASC
`) as any[];

console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);
console.log(`Unpaid contract-ready quotes scanned: ${unpaid.length}\n`);

let changed = 0;
const heldDepositOnly: string[] = [];
for (const q of unpaid) {
  const products = (q.line_items || []) as any[];
  if (!products.length) continue;
  const next = computeFinancials(q, products);
  const unchanged =
    q.tax_cents === next.tax_cents &&
    q.total_cents === next.total_cents &&
    q.deposit_due_cents === next.deposit_due_cents &&
    q.balance_cents === next.balance_cents;
  if (unchanged) continue;

  // Scope: ONLY fix the tax bug. Skip rows whose tax/total are already correct
  // and whose only delta is the 96h deposit→100% rule — that's an unrelated
  // business-rule change, surfaced separately for a manual decision.
  const taxIsCorrect = q.tax_cents === next.tax_cents && q.total_cents === next.total_cents;
  if (taxIsCorrect) {
    heldDepositOnly.push(
      `#${q.id} ${q.event_name} #${q.event_number || "?"} [${q.center_code}] — deposit ${d(q.deposit_due_cents)} → ${d(next.deposit_due_cents)} (96h rule, tax OK)`,
    );
    continue;
  }

  changed++;
  console.log(`#${q.id} ${q.event_name} #${q.event_number || "?"} [${q.center_code}] ${q.status}`);
  console.log(
    `   tax    ${d(q.tax_cents)} → ${d(next.tax_cents)}` +
      `   total ${d(q.total_cents)} → ${d(next.total_cents)}` +
      `   deposit ${d(q.deposit_due_cents)} → ${d(next.deposit_due_cents)}` +
      `   balance ${d(q.balance_cents)} → ${d(next.balance_cents)}`,
  );

  if (APPLY) {
    await sql`
      UPDATE group_function_quotes SET
        tax_cents = ${next.tax_cents},
        total_cents = ${next.total_cents},
        deposit_due_cents = ${next.deposit_due_cents},
        balance_cents = ${next.balance_cents},
        updated_at = NOW()
      WHERE id = ${q.id}`;
    console.log(`   ✓ written`);
  }
}

console.log(`\n${APPLY ? "Updated" : "Would update"}: ${changed} quote(s) (tax fixes only).`);
if (heldDepositOnly.length) {
  console.log(`\nHELD BACK (96h deposit-only flips, no tax error — decide separately):`);
  for (const h of heldDepositOnly) console.log(`  ${h}`);
}
if (!APPLY && changed > 0) console.log("\nRe-run with --apply to write.");
