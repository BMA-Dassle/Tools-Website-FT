/**
 * Real wiring for the deal-refund plan and executor.
 *
 * `refund-plan.ts` and `refund.ts` take every dependency as a function so they
 * can be tested without a network. This is the one place those functions are
 * bound to actual Square and Neon, which keeps the adapter thin and keeps the
 * decision logic honest — nothing below imports a client.
 */

import { createDigitalGiftCard } from "@/lib/square-gift-card";
import { fetchOrderFacts, fetchPaymentFacts } from "~/features/cancellation/square-actions";
import { createReturnOrder, refundTenderPartial } from "~/features/reservation-edit/square-actions";
import { spentItemIndexes } from "~/features/game-cards/data/voucher-claims-db";
import { webSalesGiftCardRefundEnabled, webSalesRefundsEnabled } from "~/features/web-sales/flags";
import { getDeal, type DealCatalogEntry } from "../catalog";
import type { DealPurchaseRow } from "../data/deal-purchases-db";
import { listDealRefunds, type DealRefundDestination } from "../data/deal-refunds-db";
import { packLegMap } from "./pack-legs";
import { buildDealRefundPlan, type DealRefundPlan } from "./refund-plan";
import { executeDealRefund, type ExecuteRefundResult } from "./refund";
import { giftCardBalanceCents, refundToGiftCard } from "./refund-square";
import { buildDealOrder, DEAL_SQUARE_LOCATION } from "./quote";
import { squareFetch } from "~/features/account/data/square-client";

/**
 * Tax-inclusive total for `packs` packs, from Square's own calculator.
 *
 * Uses `buildDealOrder` — the SAME builder the sale used — so the tax object and
 * its scope are identical to what the buyer was charged against. Any second
 * implementation of that rounding eventually disagrees with the captured amount,
 * which this repo hard-fails on by rule.
 */
async function quotePacks(
  deal: DealCatalogEntry,
  row: DealPurchaseRow,
  packs: number,
): Promise<number> {
  const order = buildDealOrder({ deal, location: row.locationKey, qty: packs });
  const { ok, data } = await squareFetch<{ order?: { total_money?: { amount?: number } } }>(
    "/orders/calculate",
    { method: "POST", body: JSON.stringify({ order }) },
  );
  const total = data?.order?.total_money?.amount;
  if (!ok || typeof total !== "number" || total <= 0) {
    throw new Error("Square could not price this return");
  }
  return total;
}

/** Build a plan against live Square and Neon. */
export async function planDealRefund(args: {
  row: DealPurchaseRow;
  destination: DealRefundDestination;
  unitKeys: string[] | null;
  override?: boolean;
}): Promise<DealRefundPlan> {
  return buildDealRefundPlan({
    ...args,
    deps: {
      spentIndexes: spentItemIndexes,
      fetchOrder: async (orderId) => {
        const facts = await fetchOrderFacts(orderId);
        return {
          lineItems: (facts.lineItems ?? []).map((l) => ({
            uid: l.uid,
            catalogObjectId: l.catalogObjectId ?? null,
          })),
          tenderCount: facts.tenders?.length ?? 0,
        };
      },
      fetchPayment: async (paymentId) => {
        const p = await fetchPaymentFacts(paymentId);
        return {
          status: p.status,
          amountCents: p.amountCents,
          refundedCents: p.refundedCents,
          // Square omits it on some tenders; an unknown source must not read as a card.
          sourceType: p.sourceType ?? "UNKNOWN",
        };
      },
      quotePacks,
      listRefunds: listDealRefunds,
      refundsEnabled: webSalesRefundsEnabled,
      giftCardRefundsEnabled: webSalesGiftCardRefundEnabled,
    },
  });
}

/** Run a freshly-verified plan against live Square. */
export async function runDealRefund(args: {
  row: DealPurchaseRow;
  plan: DealRefundPlan;
  reason: string;
  actor: string;
  override: boolean;
}): Promise<ExecuteRefundResult> {
  const deal = getDeal(args.row.dealSlug);
  if (!deal) throw new Error(`unknown deal ${args.row.dealSlug}`);
  const itemsPerPack = deal.items.length;

  const allPacks = packLegMap({
    combine: args.row.combine,
    qty: args.row.qty,
    codes: args.row.codes,
    itemsPerPack,
  });

  return executeDealRefund({
    ...args,
    deps: {
      createReturnOrder,
      refundTenderPartial,
      createDigitalGiftCard,
      refundToGiftCard,
      giftCardBalanceCents,
      locationIdFor: (row) => DEAL_SQUARE_LOCATION[row.locationKey],
      lineUidFor: async (row) => {
        const facts = await fetchOrderFacts(row.squareOrderId!);
        const uid = facts.lineItems?.[0]?.uid;
        if (!uid) throw new Error("Square order has no line item uid to return");
        return uid;
      },
      legsForPacks: (_row, packIndexes) =>
        allPacks.filter((p) => packIndexes.includes(p.pack)).map(({ code, legIndexes }) => ({
          code,
          legIndexes,
        })),
      remainingPacksForCode: (_row, code, refundedPackIndexes) => {
        // Packs on THIS code that are not part of this refund. A combined code
        // keeps its other packs, and voiding it would destroy value the guest
        // still owns.
        const gone = new Set(refundedPackIndexes);
        return allPacks.filter((p) => p.code === code && !gone.has(p.pack)).length;
      },
    },
  });
}
