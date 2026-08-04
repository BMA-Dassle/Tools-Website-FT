/**
 * Cross-source rollup for the board header.
 *
 * The cards have to stay meaningful when several products are on screen at once,
 * so the shared four are money and counts — the only things every source agrees
 * on. Anything product-specific ("packs awaiting codes") lives in
 * `SaleSummary.extra` and is shown ONLY when a single source is selected, which
 * is how today's per-deal rollup survives being merged into a generic board
 * rather than being quietly dropped.
 *
 * Aggregates come from the ADAPTER, not from the current page. A summary computed
 * over 50 visible rows would silently mean something different from the label
 * above it the moment there were 51 sales.
 */

import type { SaleListQuery, SaleSummary, WebSaleAdapter } from "../types";

export const EMPTY_SUMMARY: SaleSummary = {
  grossCents: 0,
  refundedCents: 0,
  saleCount: 0,
  unitCount: 0,
  problemCount: 0,
  extra: [],
};

/**
 * Sum the shared figures. `extra` is carried through ONLY for a single source —
 * two products' bespoke cards side by side have no shared meaning, and stacking
 * them makes the header longer than the data.
 */
export function combineSummaries(parts: SaleSummary[]): SaleSummary {
  const total = parts.reduce<SaleSummary>(
    (acc, p) => ({
      grossCents: acc.grossCents + p.grossCents,
      refundedCents: acc.refundedCents + p.refundedCents,
      saleCount: acc.saleCount + p.saleCount,
      unitCount: acc.unitCount + p.unitCount,
      problemCount: acc.problemCount + p.problemCount,
      extra: [],
    }),
    { ...EMPTY_SUMMARY },
  );
  return parts.length === 1 ? { ...total, extra: parts[0].extra } : total;
}

export interface SummarizeResult {
  total: SaleSummary;
  /** Per-source, for the "by source" chip row. Order follows the adapter list. */
  bySource: Array<{ source: string; label: string; summary: SaleSummary }>;
  errors: Array<{ source: string; message: string }>;
}

export async function summarizeWebSales(args: {
  adapters: WebSaleAdapter[];
  query: Omit<SaleListQuery, "before" | "limit">;
}): Promise<SummarizeResult> {
  const errors: Array<{ source: string; message: string }> = [];

  const bySource = await Promise.all(
    args.adapters.map(async (adapter) => {
      try {
        return { source: adapter.id, label: adapter.label, summary: await adapter.summarize(args.query) };
      } catch (err) {
        errors.push({
          source: adapter.id,
          message: err instanceof Error ? err.message : String(err),
        });
        // A source that failed contributes ZERO rather than being omitted, so the
        // chip row still shows it exists and the error banner explains the zero.
        return { source: adapter.id, label: adapter.label, summary: { ...EMPTY_SUMMARY } };
      }
    }),
  );

  return { total: combineSummaries(bySource.map((s) => s.summary)), bySource, errors };
}
