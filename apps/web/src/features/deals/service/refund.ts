/**
 * Execute a deal refund.
 *
 * ORDER OF OPERATIONS IS THE WHOLE DESIGN: the voucher legs are frozen BEFORE
 * any money moves.
 *
 * This repo's settled doctrine is decrement-first — the 2026-08-03 lesson
 * ("refunding a deposit while its gift card stays funded pays twice") and the
 * gift-card value-move rule both say the same thing. Voucher legs are the exact
 * analogue of that funded card: bearer value the guest is still holding.
 *
 * So we accept one failure mode and refuse another:
 *
 *   ACCEPTED   legs frozen, money not yet sent. Recoverable by replaying the
 *              same idempotency keys, and reversible by releasing our own holds.
 *   REFUSED    money sent, legs still live. A guest scans in that window and we
 *              have paid for the same value twice, permanently.
 *
 * Freezing first also buys the claim CAS as free proof the legs were genuinely
 * unspent at the instant of the refund — if someone redeemed one a second
 * earlier, the hold loses and we abort before touching money.
 *
 * PERSIST-FIRST throughout. The ledger row exists before any Square call, and
 * every external id is written the moment it exists, so a crash between "Square
 * did it" and "we know Square did it" is fixed by replaying the same key.
 */

import { claimVoucher, markVoucherClaimSpent, releaseVoucherClaim } from "~/features/game-cards/data/voucher-claims-db";
import { voidNativeVoucher } from "~/features/game-cards/service/native-voucher";
import type { DealPurchaseRow } from "../data/deal-purchases-db";
import {
  insertDealRefund,
  recomputeDealRefundTotals,
  updateDealRefund,
  type DealRefundRow,
} from "../data/deal-refunds-db";
import { dealRefundKey, dealRefundSquareKeys } from "./refund-keys";
import { DEAL_REFUND_REASON, type DealRefundPlan } from "./refund-plan";

/** Tolerance between our quote and Square's authoritative return total. */
export const DRIFT_TOLERANCE_CENTS = 2;

export class DealRefundError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RefundExecutorDeps {
  createReturnOrder: (a: {
    editId: string;
    sourceOrderId: string;
    locationId: string;
    lines: Array<{ uid: string; quantity: number }>;
    seq?: number;
  }) => Promise<{ returnOrderId: string; returnTotalCents: number }>;
  refundTenderPartial: (a: {
    editId: string;
    refundIndex: number;
    paymentId: string;
    amountCents: number;
    reason: string;
    returnOrderId?: string;
    skipGiftCardTender?: boolean;
  }) => Promise<{ refundId?: string; refundedCents: number }>;
  createDigitalGiftCard: (a: {
    locationId: string;
    idempotencyKey: string;
  }) => Promise<{ id: string; gan: string }>;
  refundToGiftCard: (a: {
    idempotencyKey: string;
    paymentId: string;
    destinationGiftCardId: string;
    amountCents: number;
    reason: string;
  }) => Promise<{ refundId: string; status: string }>;
  /** Confirms the credit actually landed. Null when unreadable. */
  giftCardBalanceCents: (giftCardId: string) => Promise<number | null>;
  /** Square location for this purchase's venue. */
  locationIdFor: (row: DealPurchaseRow) => string;
  /** The Square order's single line uid. */
  lineUidFor: (row: DealPurchaseRow) => Promise<string>;
  /** Legs per pack, so the hold knows what to freeze. */
  legsForPacks: (row: DealPurchaseRow, packIndexes: number[]) => Array<{ code: string; legIndexes: number[] }>;
  /** Packs still owned by the purchase after this refund, per code. */
  remainingPacksForCode: (row: DealPurchaseRow, code: string, refundedPackIndexes: number[]) => number;
}

export interface ExecuteRefundResult {
  refundId: number;
  squareRefundIds: string[];
  refundedCents: number;
  destination: "card" | "gift_card";
  giftCard?: { giftCardId: string; gan: string };
  voidedCodes: string[];
  /** Credit issued but not yet confirmed on the card — NOT a failure. */
  creditPending: boolean;
  warnings: string[];
}

/**
 * Run a plan.
 *
 * The plan must already be verified fresh by the caller (rebuilt and hash-
 * matched); this function does not re-plan. It owns the ledger row, the leg
 * hold, the Square calls and the recovery.
 */
export async function executeDealRefund(args: {
  row: DealPurchaseRow;
  plan: DealRefundPlan;
  reason: string;
  actor: string;
  override: boolean;
  deps: RefundExecutorDeps;
}): Promise<ExecuteRefundResult> {
  const { row, plan, deps } = args;
  const warnings: string[] = [];

  if (plan.selectedPackIndexes.length === 0) {
    throw new DealRefundError("nothing_selected", "No packs selected.");
  }

  // ── 1. allocate the attempt (persist-first) ─────────────────────────────
  const ledger = await insertDealRefund({
    purchaseId: row.id,
    refundKeyFor: (seq) => dealRefundKey(row.idempotencyKey, seq),
    destination: plan.destination,
    packs: plan.selectedPackIndexes.length,
    packIndexes: plan.selectedPackIndexes,
    plannedCents: plan.selectedTotalCents,
    reason: args.reason,
    actor: args.actor,
    planHash: plan.planHash,
    spentOverride: args.override,
    holdTxnFor: (refundKey) => `dealrf-${refundKey}`,
  });
  const keys = dealRefundSquareKeys(ledger.refundKey);
  const holdTxn = ledger.holdTxnId!;

  // ── 2. freeze the legs BEFORE any money moves ───────────────────────────
  const legs = deps.legsForPacks(row, plan.selectedPackIndexes);
  const held: Record<string, number[]> = {};
  try {
    for (const { code, legIndexes } of legs) {
      for (const itemIndex of legIndexes) {
        const claim = await claimVoucher({
          code,
          itemIndex,
          issuer: "native",
          compName: `deal refund #${ledger.id}`,
          packageId: "deal-refund",
          txnId: holdTxn,
          locationCode: row.centerCode,
        });
        if (!claim.ok) {
          // Someone redeemed this leg between the plan and now. Abort BEFORE any
          // money moves — this is the window the freeze-first ordering exists for.
          throw new DealRefundError(
            "legs_redeemed",
            `Item ${itemIndex + 1} on ${code} was redeemed while you were deciding. Re-plan the refund.`,
          );
        }
        (held[code] ??= []).push(itemIndex);
      }
    }
  } catch (err) {
    await releaseHolds(held, holdTxn);
    await fail(ledger, err);
    throw err;
  }
  await updateDealRefund(ledger.id, { state: "held", heldLegs: held });

  // ── 3. move the money ───────────────────────────────────────────────────
  let refundedCents = 0;
  let squareRefundId: string | null = null;
  let giftCard: { giftCardId: string; gan: string } | undefined;
  let creditPending = false;

  try {
    if (plan.destination === "card") {
      const [locationId, lineUid] = [deps.locationIdFor(row), await deps.lineUidFor(row)];

      const ret = await deps.createReturnOrder({
        editId: keys.returnOrder,
        sourceOrderId: row.squareOrderId!,
        locationId,
        lines: [{ uid: lineUid, quantity: plan.selectedPackIndexes.length }],
        seq: 0,
      });
      await updateDealRefund(ledger.id, {
        state: "returning",
        squareReturnOrderId: ret.returnOrderId,
      });

      // Square computes the tax-inclusive return total itself, and THAT is
      // authoritative — never our own tax maths. Within tolerance we proceed
      // with Square's figure; beyond it we refuse rather than refund more than
      // the modal displayed.
      if (ret.returnTotalCents > plan.selectedTotalCents + DRIFT_TOLERANCE_CENTS) {
        throw new DealRefundError(
          "amount_drift",
          `Square computed $${(ret.returnTotalCents / 100).toFixed(2)} for this return, not the ` +
            `$${(plan.selectedTotalCents / 100).toFixed(2)} shown. Nothing was refunded — re-plan.`,
        );
      }
      if (ret.returnTotalCents !== plan.selectedTotalCents) {
        warnings.push(
          `Refunded Square's computed total of $${(ret.returnTotalCents / 100).toFixed(2)} ` +
            `rather than the quoted $${(plan.selectedTotalCents / 100).toFixed(2)}.`,
        );
      }

      const refund = await deps.refundTenderPartial({
        editId: keys.cardRefund,
        refundIndex: 0,
        paymentId: row.squarePaymentId!,
        amountCents: ret.returnTotalCents,
        reason: DEAL_REFUND_REASON,
        returnOrderId: ret.returnOrderId,
        // A guest's own gift-card tender should take its share back too.
        skipGiftCardTender: false,
      });
      refundedCents = refund.refundedCents;
      squareRefundId = refund.refundId ?? null;
      await updateDealRefund(ledger.id, {
        squareRefundId,
        refundedCents,
        squareRefundStatus: "COMPLETED",
      });
    } else {
      // Gift card: mint a $0 destination, then credit it cross-tender.
      const card = await deps.createDigitalGiftCard({
        locationId: deps.locationIdFor(row),
        idempotencyKey: keys.giftCardCreate,
      });
      giftCard = { giftCardId: card.id, gan: card.gan };
      await updateDealRefund(ledger.id, {
        state: "refunding",
        destinationGiftCardId: card.id,
        destinationGiftCardGan: card.gan,
      });

      const refund = await deps.refundToGiftCard({
        idempotencyKey: keys.giftCardRefund,
        paymentId: row.squarePaymentId!,
        destinationGiftCardId: card.id,
        amountCents: plan.selectedTotalCents,
        reason: DEAL_REFUND_REASON,
      });
      refundedCents = plan.selectedTotalCents;
      squareRefundId = refund.refundId;
      await updateDealRefund(ledger.id, {
        state: "crediting",
        squareRefundId,
        squareRefundStatus: refund.status,
        refundedCents,
      });

      // Gate on the CARD BALANCE, not the refund status: a live smoke showed a
      // gift-card refund sitting at PENDING while the money was already on the
      // card. Square settles these in batch.
      const balance = await deps.giftCardBalanceCents(card.id);
      creditPending = balance === null || balance < refundedCents;
      if (creditPending) {
        // NOT an error. The sweep re-polls; issuing a second refund here is how
        // you pay twice.
        warnings.push(
          "The gift card has not shown the credit yet. Square posts these in batch — it usually lands within a minute.",
        );
      }
    }
  } catch (err) {
    // Money did not move (or we refused to let it). Give the legs back.
    await releaseHolds(held, holdTxn);
    await fail(ledger, err);
    throw err;
  }

  // ── 4. burn the frozen legs, terminally ─────────────────────────────────
  for (const code of Object.keys(held)) {
    await markVoucherClaimSpent(code, holdTxn).catch((err: unknown) =>
      console.error(`[deals] could not stamp refund holds spent on ${code}:`, err),
    );
  }

  // ── 5. void codes with nothing left, best-effort ────────────────────────
  const voidedCodes: string[] = [];
  for (const code of new Set(legs.map((l) => l.code))) {
    // Only when the purchase retains NO packs on this code. Voiding a combined
    // code whose other packs were kept would destroy value the guest still owns.
    if (deps.remainingPacksForCode(row, code, plan.selectedPackIndexes) > 0) continue;
    try {
      await voidNativeVoucher(code, `deal refund #${ledger.id}`);
      voidedCodes.push(code);
    } catch (err) {
      // The money is already right; this is presentation. Recorded for the sweep.
      console.error(`[deals] could not void ${code} after refund ${ledger.id}:`, err);
      warnings.push(`Voucher ${code} could not be voided — do it by hand.`);
    }
  }

  // ── 6. settle ───────────────────────────────────────────────────────────
  await updateDealRefund(ledger.id, {
    state: "settled",
    voidedCodes,
    settledAt: true,
    lastError: null,
  });
  // Recomputed FROM the ledger, never incremented, so a replay cannot double-count.
  await recomputeDealRefundTotals(row.id);

  return {
    refundId: ledger.id,
    squareRefundIds: squareRefundId ? [squareRefundId] : [],
    refundedCents,
    destination: plan.destination,
    giftCard,
    voidedCodes,
    creditPending,
    warnings,
  };
}

/**
 * Hand back the legs this attempt froze.
 *
 * Guarded on our own `txnId` inside `releaseVoucherClaim`, so it can only ever
 * free rows this refund created — never a claim a later redemption took.
 */
async function releaseHolds(held: Record<string, number[]>, holdTxn: string): Promise<void> {
  for (const code of Object.keys(held)) {
    await releaseVoucherClaim(code, holdTxn, "deal refund aborted").catch((err: unknown) =>
      console.error(`[deals] could not release refund hold on ${code}:`, err),
    );
  }
}

async function fail(ledger: DealRefundRow, err: unknown): Promise<void> {
  const code = err instanceof DealRefundError ? err.code : "error";
  const message = err instanceof Error ? err.message : String(err);
  await updateDealRefund(ledger.id, { state: "failed", lastError: `${code}: ${message}` }).catch(
    () => undefined,
  );
}
