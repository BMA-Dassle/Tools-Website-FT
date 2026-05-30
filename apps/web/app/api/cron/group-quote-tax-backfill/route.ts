import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { updateGfQuoteDetails, type GroupFunctionQuote } from "@/lib/group-function-db";
import { isTaxExempt, type HermesProduct } from "@/lib/hermes-client";
import { subtotalCents, taxCents } from "@/lib/group-function-pricing";
import { verifyCron } from "@/lib/cron-auth";

/**
 * One-time tax backfill.
 *
 * Earlier code computed product tax as `(p.tax * p.total) / p.price`, which
 * reduces to `rate × qty` and badly under-counted tax (p.tax is a RATE, so
 * line tax = `rate × total`). It also stored a tax-EXCLUSIVE total_cents from
 * the dispatch normal path. Existing quotes don't self-heal (dispatch only
 * re-scans "Send Contract"; sync only recomputes tax when products change), so
 * this route recomputes from stored line_items.
 *
 *   - Unpaid quotes (deposit_paid_at IS NULL): recompute + persist.
 *   - Paid/signed quotes: report only — never touch collected money.
 *
 * Defaults to dry-run; pass ?dryRun=0 to apply writes.
 */

type Financials = {
  tax_cents: number;
  total_cents: number;
  deposit_due_cents: number;
  balance_cents: number;
};

function computeFinancials(quote: GroupFunctionQuote, products: HermesProduct[]): Financials {
  const taxExempt = quote.is_tax_exempt || isTaxExempt(products);
  const tax = taxCents(products, taxExempt);
  const total = subtotalCents(products) + tax;

  // Deposit/balance mirror the dispatch cron rule.
  const isPostPaid = products.some((p) => p.name === "GF Post Paid Account");
  const hoursUntilEvent = (new Date(quote.event_date).getTime() - Date.now()) / 3_600_000;
  const fullPaymentRequired = !isPostPaid && hoursUntilEvent <= 96;
  const deposit = isPostPaid ? 0 : fullPaymentRequired ? total : Math.round(total / 2);
  const balance = Math.max(0, total - deposit);

  return { tax_cents: tax, total_cents: total, deposit_due_cents: deposit, balance_cents: balance };
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") !== "0"; // default true
  const q = sql();

  // ── Unpaid quotes: recompute (write unless dry-run) ──
  const unpaid = (await q`
    SELECT * FROM group_function_quotes
    WHERE deposit_paid_at IS NULL
      AND status IN ('pending', 'pending_approval', 'contract_sent', 'resign_required')
    ORDER BY id ASC
  `) as GroupFunctionQuote[];

  const recomputed: Array<{
    reservationId: string;
    eventName: string;
    status: string;
    before: Financials;
    after: Financials;
  }> = [];

  for (const quote of unpaid) {
    const products = (quote.line_items || []) as HermesProduct[];
    if (products.length === 0) continue;

    const next = computeFinancials(quote, products);
    const unchanged =
      quote.tax_cents === next.tax_cents &&
      quote.total_cents === next.total_cents &&
      quote.deposit_due_cents === next.deposit_due_cents &&
      quote.balance_cents === next.balance_cents;
    if (unchanged) continue;

    if (!dryRun) {
      await updateGfQuoteDetails(quote.id, next);
    }

    recomputed.push({
      reservationId: quote.bmi_reservation_id,
      eventName: quote.event_name || "",
      status: quote.status,
      before: {
        tax_cents: quote.tax_cents,
        total_cents: quote.total_cents,
        deposit_due_cents: quote.deposit_due_cents,
        balance_cents: quote.balance_cents,
      },
      after: next,
    });
  }

  // ── Paid/signed quotes: report only, never modify collected money ──
  const paid = (await q`
    SELECT * FROM group_function_quotes
    WHERE deposit_paid_at IS NOT NULL
    ORDER BY event_date ASC
  `) as GroupFunctionQuote[];

  const report: Array<{
    reservationId: string;
    eventName: string;
    status: string;
    storedTaxCents: number;
    correctTaxCents: number;
    storedTotalCents: number;
    correctTotalCents: number;
    shortfallCents: number;
  }> = [];

  for (const quote of paid) {
    const products = (quote.line_items || []) as HermesProduct[];
    if (products.length === 0) continue;

    const taxExempt = quote.is_tax_exempt || isTaxExempt(products);
    const correctTax = taxCents(products, taxExempt);
    const correctTotal = subtotalCents(products) + correctTax;
    const shortfall = correctTotal - quote.total_cents;
    if (shortfall === 0 && quote.tax_cents === correctTax) continue;

    report.push({
      reservationId: quote.bmi_reservation_id,
      eventName: quote.event_name || "",
      status: quote.status,
      storedTaxCents: quote.tax_cents,
      correctTaxCents: correctTax,
      storedTotalCents: quote.total_cents,
      correctTotalCents: correctTotal,
      shortfallCents: shortfall,
    });
  }

  const totalShortfallCents = report.reduce((s, r) => s + r.shortfallCents, 0);
  console.log(
    `[group-quote-tax-backfill] dryRun=${dryRun} unpaidScanned=${unpaid.length} ` +
      `recomputed=${recomputed.length} paidScanned=${paid.length} ` +
      `paidUndercollected=${report.length} totalShortfallCents=${totalShortfallCents}`,
  );

  return NextResponse.json({
    ok: true,
    dryRun,
    unpaidScanned: unpaid.length,
    unpaidRecomputed: recomputed.length,
    recomputed,
    paidScanned: paid.length,
    paidUndercollected: report.length,
    totalShortfallCents,
    report,
  });
}
