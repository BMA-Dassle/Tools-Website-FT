/**
 * The per-buyer purchase cap.
 *
 * Owner rule: at most 10 packs of a given deal per buyer, ALL TIME — not per
 * order. A per-order cap is a stepper limit and stops nothing; a buyer just
 * places a second order. So the check reads history.
 *
 * Identity is email OR phone. Neither alone is enough: a reseller varies the
 * email, and a family legitimately shares one. Matching either side is the
 * pragmatic middle — it stops casual circumvention without blocking a real
 * household that reuses a phone number.
 *
 * Split out from the route so the decision is unit-testable without a DB: the
 * arithmetic lives in `capDecision` (pure) and only the count is I/O.
 */

import { countPacksForBuyer } from "../data/deal-purchases-db";
import type { DealCatalogEntry } from "../catalog";

export interface CapDecision {
  ok: boolean;
  /** Packs already held by this buyer for this deal. */
  alreadyOwned: number;
  /** How many more they may buy right now (never negative). */
  remaining: number;
  /** Guest-facing explanation. Present only when `ok` is false. */
  message?: string;
}

/**
 * Pure cap arithmetic. Kept separate from the query so the messaging can be
 * tested exhaustively — a wrong message here reads as a bug to the buyer even
 * when the number is right.
 */
export function capDecision(args: {
  requested: number;
  alreadyOwned: number;
  maxPerBuyer: number;
  dealName: string;
}): CapDecision {
  const { requested, alreadyOwned, maxPerBuyer, dealName } = args;
  const remaining = Math.max(0, maxPerBuyer - alreadyOwned);

  if (requested < 1) {
    return { ok: false, alreadyOwned, remaining, message: "Choose at least one pack." };
  }
  if (requested > maxPerBuyer) {
    return {
      ok: false,
      alreadyOwned,
      remaining,
      message: `There's a limit of ${maxPerBuyer} ${dealName} packs per person.`,
    };
  }
  if (remaining === 0) {
    return {
      ok: false,
      alreadyOwned,
      remaining,
      message: `You've already bought the maximum of ${maxPerBuyer} ${dealName} packs. Reach out to us if you need more for a group.`,
    };
  }
  if (requested > remaining) {
    return {
      ok: false,
      alreadyOwned,
      remaining,
      message: `You've bought ${alreadyOwned} of these already, so you can add ${remaining} more (limit ${maxPerBuyer} per person).`,
    };
  }
  return { ok: true, alreadyOwned, remaining };
}

/**
 * Read history and decide. Throws if the DB is unreachable — an unenforceable
 * cap must block the sale rather than wave it through, because there is no way
 * to claw a voucher back once the codes are emailed.
 */
export async function checkBuyerCap(args: {
  deal: DealCatalogEntry;
  requested: number;
  email: string;
  phone?: string | null;
}): Promise<CapDecision> {
  const alreadyOwned = await countPacksForBuyer({
    dealSlug: args.deal.slug,
    email: args.email,
    phone: args.phone,
  });
  return capDecision({
    requested: args.requested,
    alreadyOwned,
    maxPerBuyer: args.deal.maxPerBuyer,
    dealName: args.deal.name,
  });
}
