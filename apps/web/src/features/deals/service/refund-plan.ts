/**
 * What would happen if you refunded this — computed on the SERVER, rendered
 * verbatim by the modal, and re-verified before a cent moves.
 *
 * The shape follows CancelModal / EditReservationModal: a dry-run whose response
 * IS the modal body, a hash sealing "displayed == executed", and typed refusals
 * the UI can render as a blocked state instead of a stack trace.
 *
 * EVERY DEPENDENCY IS INJECTED. Square and Neon arrive as functions, so the
 * whole guard list is testable without a network or a database — which matters
 * because these guards are the only thing between a mis-click and real money.
 */

import { planHash as hashPlan } from "~/features/reservation-edit/hash";
import {
  dealSquareCatalogId,
  dealVoucherItems,
  getDeal,
  type DealCatalogEntry,
} from "../catalog";
import type { DealPurchaseRow } from "../data/deal-purchases-db";
import type { DealRefundDestination, DealRefundRow } from "../data/deal-refunds-db";
import { PackShapeError, assertPackShape } from "./pack-legs";
import {
  choosePacksToRefund,
  packStates,
  selectPacksByUnitKey,
  spentWarning,
  type PackState,
} from "./refund-math";

/** Statuses where money was actually taken. */
const PAID = new Set(["charged", "minted", "scheduled", "sent"]);

/** The one Square refund reason a deal pack may ever carry. */
export const DEAL_REFUND_REASON = "Refund: Deal Pack";

/**
 * Reasons reserved by other domains' accounting journals.
 *
 * A refund reason is IMMUTABLE once Square records it, and the accounting portal
 * keys its journal off the string. Letting a staff member type "reservation
 * deposit" into a deal refund would double-count one economic event under the
 * wrong head, permanently. The edit route enforces the same rule.
 */
const RESERVED_REASON = /reservation deposit|group event deposit/i;

export function isReservedRefundReason(reason: string): boolean {
  return RESERVED_REASON.test(reason);
}

export interface RefundBlock {
  code: string;
  message: string;
}

export interface DealRefundPlanUnit {
  unitKey: string;
  label: string;
  refundableCents: number;
  spentLegLabels: string[];
  alreadyRefunded: boolean;
}

export interface DealRefundPlan {
  purchaseId: number;
  dealSlug: string;
  dealName: string;
  destination: DealRefundDestination;
  qty: number;
  units: DealRefundPlanUnit[];
  /** Every pack still untouched — the modal's default selection. */
  defaultUnitKeys: string[];
  selectedUnitKeys: string[];
  selectedPackIndexes: number[];
  /** Tax-inclusive, for the selection sent. The only figure the modal shows. */
  selectedTotalCents: number;
  paidCents: number;
  refundedCents: number;
  refundablePacks: number;
  fullyUnspentPacks: number;
  spentValueIncludedCents: number;
  needsOverride: boolean;
  destinations: DealRefundDestination[];
  warnings: string[];
  steps: Array<{ kind: string; detail: string; amountCents?: number; fatal: boolean }>;
  blocked: RefundBlock | null;
  planHash: string;
}

export interface OrderFacts {
  lineItems: Array<{ uid: string; catalogObjectId?: string | null; quantity?: string }>;
  tenderCount: number;
}

export interface PaymentFacts {
  status: string;
  amountCents: number;
  refundedCents: number;
  sourceType: string;
}

export interface RefundPlanDeps {
  /** Legs already claimed or spent, per code (`spentItemIndexes`). */
  spentIndexes: (code: string) => Promise<Set<number>>;
  fetchOrder: (orderId: string) => Promise<OrderFacts>;
  fetchPayment: (paymentId: string) => Promise<PaymentFacts>;
  /** Tax-inclusive total for `packs` packs, from Square's own calculator. */
  quotePacks: (deal: DealCatalogEntry, row: DealPurchaseRow, packs: number) => Promise<number>;
  listRefunds: (purchaseId: number) => Promise<DealRefundRow[]>;
  /** Kill switch. Blocks EXECUTE only — the plan always renders. */
  refundsEnabled: () => boolean;
  giftCardRefundsEnabled: () => boolean;
}

export interface BuildPlanArgs {
  row: DealPurchaseRow;
  destination: DealRefundDestination;
  /** Explicit selection. `null` = the default (every untouched pack). */
  unitKeys: string[] | null;
  override?: boolean;
  deps: RefundPlanDeps;
}

/** A plan that only carries a refusal — the modal jumps straight to `blocked`. */
function blockedPlan(
  row: DealPurchaseRow,
  destination: DealRefundDestination,
  block: RefundBlock,
): DealRefundPlan {
  return {
    purchaseId: row.id,
    dealSlug: row.dealSlug,
    dealName: getDeal(row.dealSlug)?.name ?? row.dealSlug,
    destination,
    qty: row.qty,
    units: [],
    defaultUnitKeys: [],
    selectedUnitKeys: [],
    selectedPackIndexes: [],
    selectedTotalCents: 0,
    paidCents: row.totalCents,
    refundedCents: 0,
    refundablePacks: 0,
    fullyUnspentPacks: 0,
    spentValueIncludedCents: 0,
    needsOverride: false,
    destinations: [],
    warnings: [],
    steps: [],
    blocked: block,
    planHash: "",
  };
}

export async function buildDealRefundPlan(args: BuildPlanArgs): Promise<DealRefundPlan> {
  const { row, destination, deps } = args;
  const block = (code: string, message: string) => blockedPlan(row, destination, { code, message });

  /* ── guards that need nothing external ──────────────────────────────── */

  if (!PAID.has(row.status)) {
    return block("not_charged", "This purchase was never charged — there is nothing to refund.");
  }
  if (!row.squareOrderId || !row.squarePaymentId) {
    return block(
      "no_square_ids",
      "No Square order or payment is recorded against this purchase. Refund it by hand and note the id.",
    );
  }
  if (row.codes.length === 0) {
    // Refunding here would leave the reconcile cron free to mint codes for money
    // we just gave back.
    return block(
      "not_minted",
      "The vouchers were never cut. Resend first so the codes exist, then refund.",
    );
  }
  const deal = getDeal(row.dealSlug);
  if (!deal) {
    return block("unknown_deal", `"${row.dealSlug}" is not in the catalog — the pack maths is undefined.`);
  }
  const catalogId = dealSquareCatalogId(deal);
  if (!catalogId) {
    return block("unsellable_deal", `${deal.name} has no Square catalog id — it cannot be returned.`);
  }
  try {
    assertPackShape({ combine: row.combine, qty: row.qty, codes: row.codes });
  } catch (err) {
    if (err instanceof PackShapeError) {
      return block("codes_shape_mismatch", `${err.message}. Refund this one by hand.`);
    }
    throw err;
  }

  /* ── prior attempts ─────────────────────────────────────────────────── */

  const priors = await deps.listRefunds(row.id);
  const settled = priors.filter((p) => p.state === "settled");
  const refundedPacks = settled.reduce((n, p) => n + p.packs, 0);
  const refundedCents = settled.reduce((n, p) => n + p.refundedCents, 0);
  const refundedPackIndexes = settled.flatMap((p) => p.packIndexes);

  if (refundedPacks >= row.qty) {
    return block("already_refunded", "Every pack on this purchase has already been refunded.");
  }
  const open = priors.find((p) => p.state !== "settled" && p.state !== "failed");
  if (open) {
    return block(
      "refund_in_progress",
      `Refund attempt #${open.seq} is still in flight (${open.state}). Wait for it to settle or fail.`,
    );
  }

  /* ── Square facts ───────────────────────────────────────────────────── */

  const [order, payment] = await Promise.all([
    deps.fetchOrder(row.squareOrderId),
    deps.fetchPayment(row.squarePaymentId),
  ]);

  if (payment.status !== "COMPLETED") {
    return block("payment_not_captured", `The Square payment is ${payment.status}, not COMPLETED.`);
  }
  if (order.tenderCount > 1) {
    // The purchase row stores ONE payment id, so a split tender has money we
    // cannot see or allocate across. Unreachable today (purchaseDeal never
    // passes a gift-card nonce) and shipped anyway, because the day the buy
    // panel accepts gift cards it becomes reachable.
    return block(
      "split_tender_unsupported",
      "This order was paid with more than one tender. Refund it by hand in Square.",
    );
  }
  if (order.lineItems.length !== 1) {
    return block(
      "unexpected_order_shape",
      `The Square order has ${order.lineItems.length} line items; a deal pack has exactly one.`,
    );
  }
  const line = order.lineItems[0];
  if (!line.uid) {
    // Never fall back to an amount-only refund. An unitemized refund records a
    // dollar figure and nothing else — the returned item never reaches
    // item-level reporting and QBO cannot categorise it.
    return block("no_line_uid", "The Square line item has no uid, so the return cannot be itemized.");
  }
  if (line.catalogObjectId && line.catalogObjectId !== catalogId) {
    return block(
      "order_not_this_deal",
      "The Square order's line item is not this deal — refusing to return the wrong product.",
    );
  }
  if (destination === "card" && payment.sourceType === "GIFT_CARD") {
    // Square accepts it, but the money lands back on the gift card, not a card —
    // and staff would tell the guest the wrong thing.
    return block(
      "gc_funded_original",
      "This purchase was paid with a gift card, so a card refund would credit that card. Refund to a gift card instead.",
    );
  }

  /* ── pack selection ─────────────────────────────────────────────────── */

  const spentByCode = new Map<string, Set<number>>(
    await Promise.all(
      [...new Set(row.codes)].map(async (code) => [code, await deps.spentIndexes(code)] as const),
    ),
  );

  // ONE pack's items as SOLD — base items plus whatever bonus the limited offer
  // froze onto this row. This is what sets the leg count, and it is not
  // `deal.items.length` for an offer purchase.
  const packItems = dealVoucherItems(deal, 1, row.bonusItems);

  const states = packStates({
    items: packItems,
    location: row.locationKey,
    // The price THIS buyer paid, not today's catalog price.
    pricePaidCents: row.unitPriceCents,
    dealSlug: row.dealSlug,
    combine: row.combine,
    qty: row.qty,
    codes: row.codes,
    spentByCode,
    refundedPackIndexes,
  });

  const defaults = choosePacksToRefund(states, states.filter((s) => !s.alreadyRefunded && s.fullyUnspent).length);
  const chosen: PackState[] =
    args.unitKeys === null
      ? states.filter((s) => defaults.unitKeys.includes(s.unitKey))
      : selectPacksByUnitKey(states, args.unitKeys);

  const selection = {
    packIndexes: chosen.map((s) => s.pack),
    unitKeys: chosen.map((s) => s.unitKey),
    spentValueIncludedCents: chosen.reduce((n, s) => n + s.spentCents, 0),
  };
  const needsOverride = selection.spentValueIncludedCents > 0 && !args.override;

  const availablePacks = states.filter((s) => !s.alreadyRefunded).length;
  if (args.unitKeys !== null && chosen.length === 0) {
    return block("nothing_selected", "Pick at least one pack to refund.");
  }
  if (chosen.length > availablePacks) {
    return block("too_many_packs", `Only ${availablePacks} pack(s) are still refundable.`);
  }

  /* ── money ──────────────────────────────────────────────────────────── */

  // Square's own calculator on the SAME order builder the sale used, so the tax
  // object and its scope are identical. A return order cannot be created in a
  // dry run (it would persist an order), so this is an estimate the executor
  // re-checks against `return_amounts.total_money`.
  const selectedTotalCents = chosen.length > 0 ? await deps.quotePacks(deal, row, chosen.length) : 0;

  const remaining = payment.amountCents - payment.refundedCents;
  if (selectedTotalCents > remaining) {
    // Refuse rather than let refundTenderPartial silently clamp and make the
    // modal a liar about what the guest is getting.
    return block(
      "insufficient_remainder",
      `Square says only $${(remaining / 100).toFixed(2)} of this payment is still refundable.`,
    );
  }

  /* ── presentation ───────────────────────────────────────────────────── */

  const legLabels = packItems.map((_, i) => `item ${i + 1}`);
  const units: DealRefundPlanUnit[] = states.map((s) => ({
    unitKey: s.unitKey,
    label: s.unitLabel,
    refundableCents: s.alreadyRefunded ? 0 : s.unspentCents,
    spentLegLabels: s.spentSlots.map((slot) => legLabels[slot] ?? `item ${slot + 1}`),
    alreadyRefunded: s.alreadyRefunded,
  }));

  const warnings: string[] = [];
  const warn = spentWarning(chosen, row.totalCents, chosen.length);
  if (warn) warnings.push(warn);
  if (destination === "gift_card") {
    warnings.push(
      // The probe finding, stated where staff can see it rather than buried in a
      // script: Square will not let this refund be itemized.
      "A gift-card refund cannot be itemized — Square drops the credit when a refund carries an order id. The reversal will show as an amount, not as returned items.",
    );
  }

  const steps = [
    { kind: "hold_legs", detail: `Freeze the unspent items on ${chosen.length} pack(s)`, fatal: true },
    destination === "card"
      ? { kind: "return_order", detail: "Create an itemized Square return order", fatal: true }
      : { kind: "mint_gift_card", detail: "Mint a new digital gift card", fatal: true },
    {
      kind: "refund",
      detail: destination === "card" ? "Refund to the original card" : "Credit the new gift card",
      amountCents: selectedTotalCents,
      fatal: true,
    },
    { kind: "void_legs", detail: "Void the refunded packs' vouchers", fatal: false },
  ];

  const destinations: DealRefundDestination[] = deps.giftCardRefundsEnabled()
    ? ["card", "gift_card"]
    : ["card"];

  // The kill switch blocks EXECUTE, never the preview. Discovering a feature is
  // off at the moment you click the money button is the worst time to find out.
  const blocked = !deps.refundsEnabled()
    ? { code: "not_enabled", message: "Refunds are switched off (WEB_SALES_REFUNDS=false)." }
    : null;

  const plan: DealRefundPlan = {
    purchaseId: row.id,
    dealSlug: row.dealSlug,
    dealName: deal.name,
    destination,
    qty: row.qty,
    units,
    defaultUnitKeys: defaults.unitKeys,
    selectedUnitKeys: selection.unitKeys,
    selectedPackIndexes: selection.packIndexes,
    selectedTotalCents,
    paidCents: row.totalCents,
    refundedCents,
    refundablePacks: availablePacks,
    fullyUnspentPacks: defaults.fullyUnspentPacks,
    spentValueIncludedCents: selection.spentValueIncludedCents,
    needsOverride,
    destinations,
    warnings,
    steps,
    blocked,
    planHash: "",
  };
  plan.planHash = dealPlanHash(plan, { row, payment, line, spentByCode, override: !!args.override });
  return plan;
}

/**
 * The seal on "what you saw is what you executed".
 *
 * The SPENT FINGERPRINT is why this is not optional. The spent set is LIVE — a
 * guest can walk up to a kiosk and scan the very code being refunded between the
 * modal opening and the operator clicking execute. Nothing else in the flow
 * notices; with the fingerprint in the hash, that becomes a `plan_stale` 409 and
 * a re-plan instead of a refund computed against a world that no longer exists.
 *
 * It also catches a second refund landing concurrently, and a human refunding
 * part of the payment in the Square Dashboard mid-decision.
 */
export function dealPlanHash(
  plan: DealRefundPlan,
  ctx: {
    row: DealPurchaseRow;
    payment: PaymentFacts;
    line: { uid: string };
    spentByCode: Map<string, Set<number>>;
    override: boolean;
  },
): string {
  return hashPlan({
    purchaseId: plan.purchaseId,
    destination: plan.destination,
    packs: plan.selectedUnitKeys.length,
    packIndexes: [...plan.selectedPackIndexes].sort((a, b) => a - b),
    selectedTotalCents: plan.selectedTotalCents,
    refundedCents: plan.refundedCents,
    refundablePacks: plan.refundablePacks,
    spentFingerprint: [...ctx.spentByCode.entries()]
      .map(([code, set]) => [code, [...set].sort((a, b) => a - b)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    squareOrderId: ctx.row.squareOrderId,
    squarePaymentId: ctx.row.squarePaymentId,
    lineUid: ctx.line.uid,
    paymentRemainingCents: ctx.payment.amountCents - ctx.payment.refundedCents,
    override: ctx.override,
  });
}
