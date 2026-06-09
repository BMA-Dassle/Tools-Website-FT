/**
 * Race-credit type registry — which BMI deposit kinds count as redeemable race
 * credits in the v2 $0 model, their PRIORITY for combined drawdown, and their day
 * eligibility.
 *
 * Why this exists: with $0 build products the BMI bill is $0, so BMI no longer
 * auto-applies a returning racer's race credit. The v2 flow offers an explicit
 * "pay with credits" option; this registry is the configurable source of truth for
 * which deposit kinds are valid race credits, their label, the order we draw them
 * down, and whether they're day-locked.
 *
 * Credits are BMI deposit-ledger rows (T_DEPOSIT) keyed to ONE personId — never
 * pooled or transferable. Only a returning racer or their linked family member
 * (bmiPersonId && !isNewRacer) may redeem, and only their OWN balances.
 *
 * Combined drawdown: when a racer opts to use credits, their heats are covered by
 * pulling from their eligible balances in PRIORITY order (Membership → Weekday →
 * Anytime → Comp), spilling into the next kind as each runs out, until the heats
 * are covered or the credits run out (the remainder is paid in cash).
 *
 * This file is PURE (no server imports) so it can be used by both the checkout UI
 * and the server reserve routes. The actual balance read + deduction (Pandora /
 * retry-queue) lives in `../service/race-credit-redeem.ts` (server-only).
 *
 * Deposit-kind ids mirror `DEPOSIT_KIND` in `lib/pandora-deposits.ts` and were
 * verified against the live BMI office `deposit/history` API (2026-06-09).
 */
import type { BookingSession, RaceHeatAssignment } from "../state/types";

export interface RaceCreditType {
  /** BMI deposit-kind id this credit deducts from. */
  depositKindId: string;
  /** Shown to the racer at checkout. */
  label: string;
  /** Lowercase substrings matched against the deposit NAME returned by
   *  `/api/bmi-office?action=deposits` (e.g. "Credit - Race Anytime"). */
  namePatterns: string[];
  /** Drawdown order when a racer has multiple eligible kinds — LOWER goes first.
   *  Membership(1) → Weekday(2) → Anytime(3) → Comp(4). */
  priority: number;
  /** Day restriction: "weekday" = Mon–Thu, "weekend" = Fri–Sun. Omit = any day.
   *  Per product rule, only the Weekday credit is day-locked; Membership, Anytime
   *  and Comp are valid any day. */
  dayLock?: "weekday" | "weekend";
  /** true = depletable credit we deduct on redemption. */
  redeemable: boolean;
}

/**
 * Valid race-credit types, in drawdown-PRIORITY order. Edit this list to
 * add/adjust credit kinds.
 *  - Membership: drawn down FIRST; valid any day (a depletable balance, e.g. 8).
 *  - Weekday:    valid Mon–Thu only (the one day-locked kind).
 *  - Anytime:    valid any day.
 *  - Comp:       staff give-back credits — valid any day, drawn down LAST.
 */
export const RACE_CREDIT_TYPES: RaceCreditType[] = [
  {
    depositKindId: "12754483",
    label: "Race Membership",
    namePatterns: ["race membership", "membership"],
    priority: 1,
    redeemable: true,
  },
  {
    depositKindId: "12744867",
    label: "Weekday Race Credit",
    namePatterns: ["race weekday", "weekday race", "weekday", "mon-thu", "mon thu"],
    priority: 2,
    dayLock: "weekday",
    redeemable: true,
  },
  {
    depositKindId: "12744871",
    label: "Anytime Race Credit",
    namePatterns: ["race anytime", "anytime race", "anytime"],
    priority: 3,
    redeemable: true,
  },
  {
    depositKindId: "11260967",
    label: "Race Comp",
    namePatterns: ["race comp", "comp race", "comp"],
    priority: 4,
    redeemable: true,
  },
];

/** Mon–Thu = "weekday", Fri–Sun = "weekend". Local-time parse to avoid UTC drift.
 *  Note: this is day-of-week based (Tuesday is a weekday for credit purposes),
 *  independent of race-pricing's `Schedule` which buckets Tuesday as "mega". */
export function dayBucket(dateYmd: string): "weekday" | "weekend" {
  const m = dateYmd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dateYmd);
  const day = d.getDay(); // 0 Sun … 6 Sat
  return day >= 1 && day <= 4 ? "weekday" : "weekend";
}

/** Resolve a credit type from a deposit NAME (from the bmi-office balance read). */
export function creditTypeForDepositName(name: string): RaceCreditType | null {
  const lower = name.toLowerCase();
  return RACE_CREDIT_TYPES.find((t) => t.namePatterns.some((p) => lower.includes(p))) ?? null;
}

/** Resolve a credit type from its deposit-kind id. */
export function creditTypeById(depositKindId: string): RaceCreditType | null {
  return RACE_CREDIT_TYPES.find((t) => t.depositKindId === depositKindId) ?? null;
}

/** Is this credit type redeemable on the given race date (day-lock check)? */
export function isTypeEligibleOnDate(type: RaceCreditType, raceDate: string | null): boolean {
  if (!type.dayLock) return true;
  if (!raceDate) return false;
  return dayBucket(raceDate) === type.dayLock;
}

/** Redeemable credit kinds usable on `raceDate` (day-eligible), highest priority
 *  first. The order the combined drawdown consumes them in. */
export function eligibleKindsByPriority(raceDate: string | null): RaceCreditType[] {
  return RACE_CREDIT_TYPES.filter((t) => t.redeemable && isTypeEligibleOnDate(t, raceDate)).sort(
    (a, b) => a.priority - b.priority,
  );
}

/** A member's available balance for one deposit-kind id, summed across the
 *  matching credit-balance rows (matched by name → kind). */
export function memberBalanceForKind(
  creditBalances: Array<{ kind: string; balance: number }> | undefined,
  depositKindId: string,
): number {
  if (!creditBalances?.length) return 0;
  let total = 0;
  for (const cb of creditBalances) {
    if (creditTypeForDepositName(cb.kind)?.depositKindId === depositKindId) {
      total += cb.balance > 0 ? cb.balance : 0;
    }
  }
  return total;
}

/** Total credits a member can apply to a race on `raceDate`, COMBINED across all
 *  eligible kinds (Membership + Weekday + Anytime + Comp), capped by their
 *  balances. Drives the "covers N of M heats" checkout summary. */
export function memberEligibleCreditTotal(
  creditBalances: Array<{ kind: string; balance: number }> | undefined,
  raceDate: string | null,
): number {
  return eligibleKindsByPriority(raceDate).reduce(
    (sum, t) => sum + memberBalanceForKind(creditBalances, t.depositKindId),
    0,
  );
}

/** Per-kind eligible balances a member has on `raceDate`, in priority order,
 *  balance>0 only. For the checkout summary line (e.g. "8 Race Membership · 2
 *  Weekday Race Credit"). */
export function memberEligibleBreakdown(
  creditBalances: Array<{ kind: string; balance: number }> | undefined,
  raceDate: string | null,
): Array<{ label: string; balance: number }> {
  return eligibleKindsByPriority(raceDate)
    .map((t) => ({
      label: t.label,
      balance: memberBalanceForKind(creditBalances, t.depositKindId),
    }))
    .filter((x) => x.balance > 0);
}

/** One credit redemption = one race heat covered by one credit. */
export interface CreditRedemption {
  /** BMI personId whose balance is drawn down. */
  personId: string;
  /** Deposit-kind id to deduct from (resolved by the priority drawdown). */
  depositKindId: string;
  /** Stable per-heat reference for idempotency (heatId, else itemId:index). */
  ref: string;
}

interface HeatRedemption extends CreditRedemption {
  /** The heat assignment this redemption covers (object identity). */
  heat: RaceHeatAssignment;
}

/**
 * Core walk: assign each race heat of an opted-in member (`redeemCredits`) the
 * next available credit in PRIORITY order (Membership → Weekday → Anytime → Comp),
 * restricted to kinds eligible on that heat's race date, decrementing a per-member
 * running balance so we never over-redeem. Heats beyond the member's combined
 * eligible balance get no redemption (paid in cash). Walked in session order so the
 * $0-charged heats, the displayed split, and the server deduction all cover the
 * IDENTICAL heats. Non-transferable: keyed to the assigned member's own bmiPersonId.
 */
function computeCreditRedemptions(session: BookingSession): HeatRedemption[] {
  const out: HeatRedemption[] = [];
  // memberId -> (depositKindId -> remaining balance), decremented as heats are covered.
  const remaining = new Map<string, Map<string, number>>();
  for (const item of session.items) {
    if (item.kind !== "race") continue;
    const order = eligibleKindsByPriority(item.date ?? null);
    item.heats.forEach((h, i) => {
      if (!h.assignedTo) return;
      const m = session.party.find((p) => p.id === h.assignedTo);
      if (!m?.bmiPersonId || !m.redeemCredits) return;
      let rem = remaining.get(m.id);
      if (!rem) {
        rem = new Map();
        for (const t of RACE_CREDIT_TYPES) {
          if (!t.redeemable) continue;
          const bal = memberBalanceForKind(m.creditBalances, t.depositKindId);
          if (bal > 0) rem.set(t.depositKindId, bal);
        }
        remaining.set(m.id, rem);
      }
      // Highest-priority eligible kind that still has a remaining credit.
      const kind = order.find((t) => (rem!.get(t.depositKindId) ?? 0) > 0);
      if (!kind) return; // member's eligible credits exhausted — this heat is cash
      rem.set(kind.depositKindId, (rem.get(kind.depositKindId) ?? 0) - 1);
      out.push({
        heat: h,
        personId: m.bmiPersonId,
        depositKindId: kind.depositKindId,
        ref: h.heatId ?? `${item.id}:${i}`,
      });
    });
  }
  return out;
}

/**
 * Per-heat credit redemptions for a session: personId + the kind drawn for that
 * heat (priority-combined across the member's eligible balances) + a stable ref.
 * The server re-validates each against the LIVE balance before charging. The
 * displayed split (`applyCreditRedemptionsToOverview`) and the cash-path charge
 * (`redeemedHeatSet`) derive from this SAME walk, so displayed == charged == deducted.
 */
export function redemptionsFromSession(session: BookingSession): CreditRedemption[] {
  return computeCreditRedemptions(session).map(({ personId, depositKindId, ref }) => ({
    personId,
    depositKindId,
    ref,
  }));
}

/** The exact heat ASSIGNMENTS covered by credits — keyed on the heat OBJECT, not
 *  its heatId (multiple racers can share one heatId in a single session). The cash
 *  reserve path drops these from the Square charge so a racer with fewer credits
 *  than heats is charged only for the uncovered heats (the rest are $0). */
export function redeemedHeatSet(session: BookingSession): Set<RaceHeatAssignment> {
  return new Set(computeCreditRedemptions(session).map((r) => r.heat));
}
