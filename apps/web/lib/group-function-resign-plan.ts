/**
 * What a re-sign asks of the guest, money-wise.
 *
 * These four facts decide whether the contract page shows a payment step, whether it
 * demands a card, and what the Sign button promises. Every one of them MUST agree with
 * `/api/group-function/resign-settle`, which is the only thing that actually moves
 * money — it charges on exactly one branch, `wasPaidInFull` (`balance_paid_at` set) with
 * a delta of at least $1, and returns without charging on every other.
 *
 * Extracted from ContractClient on 2026-09-13 because the UI had drifted from that
 * server gate. `resignNeedsCard` keyed off `isResign` rather than "settles now":
 *
 *   needsCard = isResign && dueCents > 0 && !hasCardOnFile
 *
 * A post-paid or deposit-only event has collected_cents < total_cents BY DESIGN, so
 * dueCents is always > 0, and a post-paid account never has a card on file. Contract
 * c31e3aec (Strikes for Scholarships, FGCU — invoiced, $8,538.84, nothing collected)
 * would therefore have been sent to a pay step demanding the full balance on a card
 * just to re-confirm a DATE change. The server would have charged nothing; the guest
 * would simply have been unable to finish. Latent until 2026-09-13 because only a price
 * change could trigger a re-sign, and paid-in-full events — the ones a price change
 * usually hits — have a card on file, which masked it.
 */

export interface ResignPlanFacts {
  status: string;
  /** Signed and deposit settled. A re-sign is only meaningful after this. */
  depositPaidAt: string | null;
  /**
   * Set once a balance charge lands, and never cleared by a re-price — a LATCH.
   * This is `wasPaidInFull` in resign-settle. Do not substitute anything that merely
   * looks equivalent (balance_cents === 0, collected >= total): those move under a
   * re-price and the copy would promise the guest the wrong thing.
   */
  balancePaidAt: string | null;
  totalCents: number;
  collectedCents: number;
  hasCardOnFile: boolean;
}

export interface ResignPlan {
  /** The page is in re-sign mode at all. */
  isResign: boolean;
  /** Signing settles the difference on the spot (resign-settle will charge). */
  settlesNow: boolean;
  /** Amount outstanding: total − collected. The same subtraction resign-settle does. */
  dueCents: number;
  /** A card must be collected before the re-sign can complete. */
  needsCard: boolean;
  /**
   * What the Sign button does next:
   *   "pay"                → settles a real amount inline; name it on the button
   *   "confirm"            → nothing to settle here; the balance stays on its existing
   *                          rail (72h cron, or an invoice for a post-paid account)
   *   "continue-to-payment" → a pay step genuinely follows
   */
  signAction: "pay" | "confirm" | "continue-to-payment";
}

export function resignPlan(f: ResignPlanFacts): ResignPlan {
  const isResign = f.status === "resign_required" && Boolean(f.depositPaidAt);
  const settlesNow = isResign && Boolean(f.balancePaidAt);
  const dueCents = Math.max(0, f.totalCents - f.collectedCents);
  // Only a settle-now re-sign can charge, so only a settle-now re-sign can need a card.
  const needsCard = settlesNow && dueCents > 0 && !f.hasCardOnFile;

  const signAction: ResignPlan["signAction"] = !isResign
    ? "continue-to-payment"
    : needsCard
      ? "continue-to-payment"
      : settlesNow && dueCents > 0
        ? "pay"
        : "confirm";

  return { isResign, settlesNow, dueCents, needsCard, signAction };
}
