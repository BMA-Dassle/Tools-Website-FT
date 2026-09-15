/**
 * Race Sim CREDIT redemption — the spend side of a sim pack.
 *
 * Karting's equivalent is data/race-credits.ts + service/race-credit-redeem.ts.
 * This is the same idea with two deliberate differences:
 *
 *  1. ITS OWN KIND. Sim credits live on "Credit - Race Simulator" (61079628)
 *     and are resolved HERE, never through RACE_CREDIT_TYPES. That registry is
 *     what karting's redemption walks, so putting the sim kind in it would make
 *     a sim credit spend at $0 on a kart heat. The two ledgers stay separate by
 *     construction, and products.test.ts asserts it in both directions.
 *
 *  2. PER (SESSION x RACER), NOT PER LINE. A kart heat is one line per racer, so
 *     covering a heat covers one person. A sim session is ONE line for the whole
 *     party (quantity = racerCount), so a party of three where one person holds
 *     a credit has to split into a paid line of 2 and a $0 line of 1. The walk
 *     below therefore returns a per-racer coverage count per session, and the
 *     charge builder splits on it.
 *
 * Balance source is the member's client-side `creditBalances` SNAPSHOT (deposit
 * NAME + balance), the same input karting's checkout opt-in reads. It is a
 * display-side figure: the authoritative deduction happens after capture via
 * deductCreditRedemptions, which is idempotent per (bill, person, ref), so a
 * stale snapshot can over-offer at most and never double-deduct.
 */
import type { BookingSession, RaceSimItem } from "~/features/booking/state/types";
import { creditTypeForDepositName } from "~/features/booking/data/race-credits";
import { RACE_SIM_DEPOSIT_KIND, getRaceSimProduct } from "./products";

/**
 * Deposit NAME fragments that identify a SIM credit row.
 *
 * Matched lowercase-substring, the same way karting matches its own kinds. A
 * row that ALSO resolves to a karting kind is rejected outright below — a name
 * can only belong to one ledger, and if that ever became ambiguous the safe
 * answer is "not a sim credit" rather than spending someone's kart credits.
 */
const SIM_CREDIT_NAME_PATTERNS = ["race simulator", "race sim"] as const;

/** Is this deposit row a sim credit? */
export function isSimCreditName(name: string | null | undefined): boolean {
  const lower = String(name ?? "").toLowerCase();
  if (!lower) return false;
  if (!SIM_CREDIT_NAME_PATTERNS.some((p) => lower.includes(p))) return false;
  // Belt and braces: never claim a row karting already owns.
  return creditTypeForDepositName(lower) == null;
}

/** A member's spendable sim-credit balance from their snapshot. */
export function simCreditBalance(
  creditBalances: Array<{ kind: string; balance: number }> | undefined,
): number {
  if (!creditBalances?.length) return 0;
  let total = 0;
  for (const cb of creditBalances) {
    if (isSimCreditName(cb.kind) && cb.balance > 0) total += cb.balance;
  }
  return total;
}

/** One racer's seat in one session, covered by one sim credit. */
export interface SimCreditRedemption {
  personId: string;
  depositKindId: string;
  /** Stable per (session, person) reference — the idempotency key half. */
  ref: string;
}

export interface SimSessionCoverage {
  /** Item the session belongs to. */
  itemId: string;
  /** The session's wall-clock start. */
  slot: string;
  /** How many of this session's seats are covered by credits. */
  covered: number;
  /** Redemptions backing those seats. */
  redemptions: SimCreditRedemption[];
}

/**
 * Walk the cart's sim SINGLES and cover seats with the riders' own sim credits.
 *
 * Only members who opted in (`redeemCredits`, the checkout toggle) and who have
 * a bmiPersonId are considered — a credit is non-transferable and there is no
 * ledger to draw from without a person. A running per-member balance is
 * decremented as seats are covered, so a member with 2 credits across 3
 * sessions covers exactly 2 and pays cash for the third.
 *
 * PACKS are skipped: buying credits never spends them.
 */
export function computeRaceSimCoverage(session: BookingSession): SimSessionCoverage[] {
  const kindId = RACE_SIM_DEPOSIT_KIND.anytime;
  if (!kindId) return [];
  const out: SimSessionCoverage[] = [];
  // memberId → credits still unspent in this cart.
  const remaining = new Map<string, number>();

  for (const item of session.items) {
    if (item.kind !== "racesim") continue;
    const sim = item as RaceSimItem;
    if (getRaceSimProduct(sim.productSlug)?.kind === "pack") continue;

    // Who rides: the item's own roster, else the whole party (the kiosk stamps
    // "everyone races", matching how the seats are counted at charge time).
    const riderIds =
      sim.assignedTo.length > 0
        ? sim.assignedTo
        : (sim.participants ?? []).length > 0
          ? (sim.participants as string[])
          : session.party.map((m) => m.id);

    // Sessions in a stable order so the $0-charged seats, the displayed split
    // and the server deduction always cover the IDENTICAL seats.
    const sessions = [...sim.sessions].sort((a, b) => a.slot.localeCompare(b.slot));
    for (const s of sessions) {
      const redemptions: SimCreditRedemption[] = [];
      for (const id of riderIds) {
        const m = session.party.find((p) => p.id === id);
        if (!m?.bmiPersonId || !m.redeemCredits) continue;
        let left = remaining.get(m.id);
        if (left === undefined) {
          left = simCreditBalance(m.creditBalances);
          remaining.set(m.id, left);
        }
        if (left <= 0) continue;
        remaining.set(m.id, left - 1);
        redemptions.push({
          personId: m.bmiPersonId,
          depositKindId: kindId,
          ref: `sim:${s.slot}:${m.bmiPersonId}`,
        });
      }
      if (redemptions.length > 0) {
        out.push({ itemId: sim.id, slot: s.slot, covered: redemptions.length, redemptions });
      }
    }
  }
  return out;
}

/** Every redemption in the cart, flattened — what the deduct rail consumes. */
export function raceSimRedemptions(session: BookingSession): SimCreditRedemption[] {
  return computeRaceSimCoverage(session).flatMap((c) => c.redemptions);
}

/** Seats covered for one session, for the charge builder's line split. */
export function coveredSeatsFor(
  coverage: SimSessionCoverage[],
  itemId: string,
  slot: string,
): number {
  return coverage.find((c) => c.itemId === itemId && c.slot === slot)?.covered ?? 0;
}
