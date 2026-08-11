/**
 * Pure guard/derivation functions for the cancellation cascade — no I/O, unit
 * tested. Every rule here traces to a production incident or a hard rule in
 * tasks/lessons.md; see comments on each function.
 */
import type { BowlingReservation } from "@/lib/bowling-db";
import {
  SQUARE_TOKEN_CATALOG_ID,
  SQUARE_ACTIVATION_FEE_CATALOG_ID,
} from "~/features/game-cards/constants";
import { CancelGuardError, type CancelActor, type GatheredFacts, type MoneyClass } from "./types";

/** UTC instant → naive ET wall-clock ISO ("2026-07-03T14:00:00"). */
export function toEtWallClock(instant: Date): string {
  return instant.toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T");
}

/**
 * The reservation's real EVENT start as a naive ET wall-clock ISO. booked_at is
 * the booking timestamp for race/attraction rows — the actual times live in
 * booking_metadata (heats[].heatId / attractions[].slot, both naked-local ET
 * ISO strings, so min() by lexical order is chronological). TS port of the
 * COALESCE in closePastReservationStatuses (bowling-db.ts).
 */
export function eventStartEt(r: BowlingReservation): string {
  const md = r.bookingMetadata as
    | { heats?: Array<{ heatId?: unknown }>; attractions?: Array<{ slot?: unknown }> }
    | undefined;
  const heatTimes = Array.isArray(md?.heats)
    ? md.heats.map((h) => h?.heatId).filter((v): v is string => typeof v === "string" && v !== "")
    : [];
  if (heatTimes.length) return heatTimes.reduce((a, b) => (a < b ? a : b));
  const slotTimes = Array.isArray(md?.attractions)
    ? md.attractions
        .map((a) => a?.slot)
        .filter((v): v is string => typeof v === "string" && v !== "")
    : [];
  if (slotTimes.length) return slotTimes.reduce((a, b) => (a < b ? a : b));
  return toEtWallClock(new Date(r.bookedAt));
}

/**
 * Customer self-serve cutoff: changes close 1 hour before the EARLIEST leg's
 * event time (same rule as the existing bowling cancel). Lexical compare of
 * naive-ET strings is chronological.
 */
export function guardCustomerCutoff(legs: BowlingReservation[], nowMs: number): void {
  const earliest = legs.map(eventStartEt).reduce((a, b) => (a < b ? a : b));
  const oneHourFromNowEt = toEtWallClock(new Date(nowMs + 60 * 60 * 1000));
  if (earliest < oneHourFromNowEt) {
    throw new CancelGuardError(
      "within_1_hour",
      "Reservation starts within 1 hour — call the center to make changes.",
      409,
    );
  }
}

/**
 * Actor/outcome policy (owner-locked 2026-07-03): combos are staff-only; card
 * refunds are staff-only for customers (allowCustomerRefund is set only by
 * admin routes — guests settle as a HeadPinz FastTrax Gift Card).
 */
export function guardActorOutcome(params: {
  isCombo: boolean;
  actor: CancelActor;
  outcome: "refund" | "store_credit";
  allowCustomerRefund?: boolean;
}): void {
  if (params.actor === "admin") return;
  if (params.isCombo) {
    throw new CancelGuardError(
      "combo_requires_admin",
      "VIP Experience combos are handled by our team — call the center.",
      403,
    );
  }
  if (params.outcome === "refund" && !params.allowCustomerRefund) {
    throw new CancelGuardError(
      "refund_requires_admin",
      "Card refunds are handled by the center — call us, or choose a gift card.",
      403,
    );
  }
}

/**
 * Money shape of the group (judged off the anchor leg's payment fields — the
 * group shares one deposit/gift card):
 *   funded — deposit charge loaded an internal gift card (the normal shape);
 *   zero   — nothing was charged (credit bookings, $0 rows): cancel-only;
 *   broken — a deposit payment exists but no gift card: the refund engine
 *            can't derive a trustworthy amount → manual path in Square.
 */
export function classifyMoney(legs: BowlingReservation[]): MoneyClass {
  const paid = legs.find((l) => l.squareDepositPaymentId);
  if (!paid) return "zero";
  const carded = legs.find((l) => l.squareGiftCardId);
  return carded ? "funded" : "broken";
}

/**
 * Day-of order disposition (ported from _itl0um08-close.mts, the proven combo
 * close-out): a TENDERED order means the guest already paid at the venue — the
 * money is no longer cleanly on the internal gift card, so the whole cascade
 * refuses ("paid" is tenders, never state === "COMPLETED" — lessons.md).
 */
export function guardDayofOrder(order: {
  state: string;
  tenderCount: number;
}): "cancel" | "skip" | "refuse" {
  if (order.tenderCount > 0) return "refuse";
  if (order.state === "CANCELED" || order.state === "CANCELLED") return "skip";
  if (order.state === "COMPLETED") return "skip";
  if (order.state === "OPEN" || order.state === "DRAFT") return "cancel";
  return "refuse";
}

/** The two Square catalog ids that mark Game Zone lines on a deposit order:
 *  token packages and the per-card activation fee. The deposit line itself
 *  carries NO catalog id, so detection can never touch it. */
const GZ_CATALOG_IDS = new Set<string>([SQUARE_TOKEN_CATALOG_ID, SQUARE_ACTIVATION_FEE_CATALOG_ID]);

/**
 * Σ Game Zone lines (token packages + activation fees) riding a deposit order —
 * kiosk bookings put card purchases on the deposit order as extra ITEM lines,
 * so the reader payment exceeds the internal gift card by exactly this amount.
 * Uses line total_money (quantity-inclusive; gz lines are untaxed, so exact).
 * NEVER derive this from intercard_transactions — that ledger records the
 * package price only and omits the $2/card activation fee.
 */
export function gameZoneCents(
  lineItems: Array<{ catalogObjectId?: string; totalCents: number }> | undefined,
): number {
  return (lineItems ?? []).reduce(
    (s, li) =>
      s + (li.catalogObjectId && GZ_CATALOG_IDS.has(li.catalogObjectId) ? li.totalCents : 0),
    0,
  );
}

export interface TenderRefund {
  paymentId: string;
  amountCents: number;
  /** True when the amount was capped below the payment's remainder (Game Zone
   *  exclusion) — the executor must pass it to Square as a partial refund. */
  partial?: boolean;
}

/**
 * Per-tender refunds still owed on the deposit order — the exactly-once core.
 * A payment's refunded_money already covers what prior attempts (or manual
 * staff refunds) issued, so a resume/re-run refunds only the remainder.
 *
 * Game Zone exclusion: card purchases riding the deposit order stay with the
 * guest, so their total is subtracted from the refundable remainder — greedily,
 * first-fit in tender order, in TWO passes. Pass 1 allocates onto CARD tenders
 * (the 2026-07-11 rule); pass 2 allocates whatever the cards couldn't absorb
 * onto GIFT_CARD tenders — legal since the 2026-07-27 live probe overturned
 * the "Square refuses partial GC refunds" claim, and NECESSARY under ambient
 * gift cards, where a gift card can fund most of a deposit order and the card
 * tender alone is smaller than the Game Zone cents. Edit top-ups never carry
 * cards in either pass. Any still-unallocatable exclusion deliberately stays
 * in the sum so guardRefundTotal trips and routes to the manual path —
 * fail-closed.
 */
export function tenderRefundsNeeded(facts: GatheredFacts): TenderRefund[] {
  const tenders = facts.depositOrder?.tenders ?? [];
  let exclude = facts.depositOrder?.gameZoneCents ?? 0;
  const slots = tenders.map((t) => {
    const pay = facts.payments[t.paymentId];
    if (!pay) {
      throw new CancelGuardError(
        "amount_mismatch",
        `Deposit tender payment ${t.paymentId} could not be fetched — manual review.`,
        409,
      );
    }
    return { t, pay, remaining: pay.amountCents - pay.refundedCents, capped: false };
  });
  const allocate = (giftCardPass: boolean) => {
    for (const s of slots) {
      if (exclude <= 0) break;
      const isGc = s.pay.sourceType === "GIFT_CARD";
      if (s.remaining <= 0 || s.t.editTopup || isGc !== giftCardPass) continue;
      const take = Math.min(exclude, s.remaining);
      s.remaining -= take;
      exclude -= take;
      if (take > 0 && s.remaining > 0) s.capped = true;
    }
  };
  allocate(false); // pass 1: cards
  allocate(true); // pass 2: gift-card tenders absorb the rest
  return slots
    .filter((s) => s.remaining > 0)
    .map((s) => ({
      paymentId: s.t.paymentId,
      amountCents: s.remaining,
      ...(s.capped ? { partial: true } : {}),
    }));
}

/**
 * "Is it safe to refund `refundsNeededCents` right now?" — safe only when the
 * internal gift card still holds exactly that money. Mismatch means partial
 * redemption or manual Square activity, where an automated full refund would
 * over- or under-pay (square-bowling-refund.ts rule, kept verbatim).
 *
 * CALLER CONTRACT: skip this guard when refundsNeededCents === 0 — that is the
 * legitimate crash-resume state (refunds already issued; the drain/teardown
 * may or may not have happened) and the money step is a no-op there.
 */
export function guardRefundTotal(params: {
  refundsNeededCents: number;
  gcBalanceCents: number;
}): void {
  if (params.refundsNeededCents !== params.gcBalanceCents) {
    throw new CancelGuardError(
      "amount_mismatch",
      `Refundable tender total (${params.refundsNeededCents}¢) ≠ gift card balance ` +
        `(${params.gcBalanceCents}¢) — partial redemption or manual activity; handle in Square.`,
      409,
    );
  }
}

/** Human display for a GAN: "1234-5678-9012-3456". Never alters the value. */
export function formatGan(gan: string): string {
  return gan.replace(/(.{4})(?=.)/g, "$1-");
}

/** Kind → guest/staff-facing label for leg summaries + notifications. */
export function legLabel(r: BowlingReservation): string {
  switch (r.productKind) {
    case "race":
      return "Karting";
    case "attraction": {
      const md = r.bookingMetadata as { attractions?: Array<{ name?: unknown }> } | undefined;
      const name = Array.isArray(md?.attractions)
        ? md.attractions.find((a) => typeof a?.name === "string")?.name
        : undefined;
      return typeof name === "string" && name ? (name as string) : "Attraction";
    }
    case "kbf":
      return "Kids Bowl Free";
    default:
      return "Bowling";
  }
}
