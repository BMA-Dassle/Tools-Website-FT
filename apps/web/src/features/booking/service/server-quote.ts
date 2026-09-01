/**
 * Server-authoritative review pricing (PR B of
 * tasks/server-quote-pricing-plan.md, owner-directed: "we shouldn't be
 * calculating this on client side at all").
 *
 * The review screen POSTs the exact session the reserve will price to
 * /api/booking/v2/quote and renders the returned lines VERBATIM — charged
 * lines with money, covered units as their own $0 lines tagged with why
 * ("Credit" · "Race Pack" · "Voucher …Z4SX" · "Included") — so displayed ≡
 * charged by construction. The client estimate stays as the fallback when
 * the quote can't be reached.
 */
import type { BookingSession } from "../state/types";
import type { BillLine, BillOverview } from "./checkout";
import { activeComboSpecial } from "~/features/combos/combo-pricing";

export interface ServerQuoteLine {
  name: string;
  quantity: number;
  unitCents: number;
  /** $0 unit but priced by the Square catalog (the $2.99 booking fee). */
  catalogPricedCents?: number;
  coverage?: {
    kind: "race-credit" | "race-pack" | "voucher" | "combo-inclusion" | "bogo-special";
    label: string;
  };
  originalUnitCents?: number;
}

export interface ServerQuote {
  lines: ServerQuoteLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/** Kill switch only (house rule) — the quote is ON unless explicitly killed. */
export function serverQuoteEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SERVER_QUOTE !== "false";
}

/** Pure fetch — null on any failure so callers fall back to the client math. */
export async function fetchServerQuote(
  session: BookingSession,
  signal?: AbortSignal,
): Promise<ServerQuote | null> {
  try {
    const res = await fetch("/api/booking/v2/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session }),
      signal,
    });
    if (!res.ok) return null;
    const q = (await res.json()) as ServerQuote;
    return Array.isArray(q?.lines) && typeof q.totalCents === "number" ? q : null;
  } catch {
    return null;
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Map a server quote onto the review's BillOverview. The quote covers the
 * unified charge; two client-side pieces are layered back on top exactly as
 * the client estimate does: Game Zone card lines (they ride the UNTAXED
 * deposit order, not the unified day-of orders — taken from the client-built
 * base so they can't double-count) and the loyalty reward discount.
 */
export function overviewFromServerQuote(
  quote: ServerQuote,
  session: BookingSession,
  base: BillOverview,
): BillOverview {
  let lines: BillLine[] = quote.lines.map((l) => {
    const unitCents = l.unitCents > 0 ? l.unitCents : (l.catalogPricedCents ?? 0);
    return {
      name: l.name,
      quantity: l.quantity,
      amount: r2((unitCents * l.quantity) / 100),
      ...(l.coverage ? { coverageLabel: l.coverage.label } : {}),
      ...(l.originalUnitCents != null && l.originalUnitCents > l.unitCents
        ? {
            originalAmount: r2((l.originalUnitCents * l.quantity) / 100),
            promoPct: session.appliedPromo?.amountPct ?? undefined,
          }
        : {}),
    };
  });

  // Flat combo: the charge splits the pack across two per-center revenue
  // lines that share the combo's name — collapse them into ONE package line
  // (same rule as the client estimate; the sum is exact, so totals hold).
  const flat = activeComboSpecial(session);
  if (flat?.combo.flatCartDisplay) {
    const isComboLine = (l: BillLine) => l.name === flat.combo.name && !l.coverageLabel;
    const comboLines = lines.filter(isComboLine);
    if (comboLines.length > 0) {
      const amount = r2(comboLines.reduce((s, l) => s + l.amount, 0));
      const hasPromo = comboLines.some((l) => l.originalAmount != null);
      lines = [
        {
          name: flat.combo.name,
          quantity: flat.racerIds.length,
          amount,
          ...(hasPromo
            ? {
                originalAmount: r2(
                  comboLines.reduce((s, l) => s + (l.originalAmount ?? l.amount), 0),
                ),
                promoPct: session.appliedPromo?.amountPct ?? undefined,
              }
            : {}),
        },
        ...lines.filter((l) => !isComboLine(l)),
      ];
    }
  }

  const gzLines = base.lines.filter((l) => l.name.startsWith("Game Zone — "));
  const gzDollars = r2(gzLines.reduce((s, l) => s + l.amount, 0));
  const rewardDiscount = (session.loyalty?.selectedRewardTier?.discountCents ?? 0) / 100;

  const subtotal = quote.subtotalCents / 100;
  const total = r2(Math.max(0, quote.totalCents / 100 - rewardDiscount) + gzDollars);
  const promoSavings = r2(
    lines.reduce((s, l) => s + (l.originalAmount != null ? l.originalAmount - l.amount : 0), 0),
  );
  const creditApplied = quote.lines.reduce(
    (s, l) => s + (l.coverage?.kind === "race-credit" ? l.quantity : 0),
    0,
  );

  return {
    lines: [...lines, ...gzLines],
    subtotal,
    tax: quote.taxCents / 100,
    total,
    cashOwed: total,
    creditApplied,
    isCreditOrder: subtotal <= 0,
    promoCode: session.appliedPromo?.code ?? null,
    promoSavings: promoSavings > 0 ? promoSavings : undefined,
  };
}
