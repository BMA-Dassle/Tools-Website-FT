/**
 * Race-credit type registry — which BMI deposit kinds count as redeemable race
 * credits in the v2 $0 model, and their day eligibility.
 *
 * Why this exists: with $0 build products the BMI bill is $0, so BMI no longer
 * auto-applies (deducts) a returning racer's race credit the way it did against a
 * priced product. The v2 flow now offers an explicit "pay with a credit" option;
 * this registry is the configurable source of truth for which deposit kinds are
 * valid race credits, their display label, and whether they're day-locked.
 *
 * Credits are BMI deposit-ledger rows (T_DEPOSIT) keyed to ONE personId — never
 * pooled or transferable. Only a returning racer or their linked family member
 * (bmiPersonId && !isNewRacer) may redeem, and only their OWN balance.
 *
 * This file is PURE (no server imports) so it can be used by both the checkout UI
 * and the server reserve routes. The actual balance read + deduction (Pandora /
 * retry-queue) lives in `../service/race-credit-redeem.ts` (server-only).
 *
 * Deposit-kind ids mirror `DEPOSIT_KIND` in `lib/pandora-deposits.ts`.
 */
import type { BookingSession } from "../state/types";

export interface RaceCreditType {
  /** BMI deposit-kind id this credit deducts from. */
  depositKindId: string;
  /** Shown to the racer at checkout. */
  label: string;
  /** Lowercase substrings matched against the deposit NAME returned by
   *  `/api/bmi-office?action=deposits` (e.g. "Credit - Race Anytime"). */
  namePatterns: string[];
  /** Day restriction: "weekday" = Mon–Thu, "weekend" = Fri–Sun. Omit = any day.
   *  Per product rule, only weekday/weekend credits are time-locked. */
  dayLock?: "weekday" | "weekend";
  /** true = depletable credit we deduct on redemption. false = ignore (e.g. an
   *  unlimited Membership pass, which is not a countable credit). */
  redeemable: boolean;
}

/**
 * Valid race-credit types. Edit this list to add/adjust credit kinds.
 *  - Anytime: redeemable any day.
 *  - Weekday: redeemable Mon–Thu only (day-locked).
 *  - Comp: staff give-back credits — redeemable any day.
 *  - Membership: an unlimited PASS, not a depletable credit → redeemable: false.
 *  - Add weekend-locked credit kinds with `dayLock: "weekend"` once their
 *    deposit-kind id is known.
 */
export const RACE_CREDIT_TYPES: RaceCreditType[] = [
  {
    depositKindId: "12744867",
    label: "Weekday Race Credit",
    namePatterns: ["race weekday", "weekday race", "weekday", "mon-thu", "mon thu"],
    dayLock: "weekday",
    redeemable: true,
  },
  {
    depositKindId: "12744871",
    label: "Anytime Race Credit",
    namePatterns: ["race anytime", "anytime race", "anytime"],
    redeemable: true,
  },
  {
    depositKindId: "11260967",
    label: "Race Comp",
    namePatterns: ["race comp", "comp race", "comp"],
    redeemable: true,
  },
  {
    depositKindId: "12754483",
    label: "Race Membership",
    namePatterns: ["race membership", "membership"],
    redeemable: false,
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

export interface EligibleCredit {
  depositKindId: string;
  label: string;
  balance: number;
}

/**
 * Redeemable credits a party member can use for a race on `raceDate`, derived
 * from their captured `creditBalances` (names) intersected with the registry +
 * day eligibility. Ordered so day-locked credits are offered first (preserve the
 * more-flexible Anytime balance), then Anytime, then others.
 */
export function eligibleCreditsForMember(
  creditBalances: Array<{ kind: string; balance: number }> | undefined,
  raceDate: string | null,
): EligibleCredit[] {
  if (!creditBalances?.length) return [];
  const out: EligibleCredit[] = [];
  for (const cb of creditBalances) {
    if (!cb.balance || cb.balance <= 0) continue;
    const type = creditTypeForDepositName(cb.kind);
    if (!type || !type.redeemable) continue;
    if (!isTypeEligibleOnDate(type, raceDate)) continue;
    out.push({ depositKindId: type.depositKindId, label: type.label, balance: cb.balance });
  }
  // Day-locked first (conserve flexible Anytime credits), then the rest.
  return out.sort((a, b) => {
    const ad = creditTypeById(a.depositKindId)?.dayLock ? 0 : 1;
    const bd = creditTypeById(b.depositKindId)?.dayLock ? 0 : 1;
    return ad - bd;
  });
}

/** One credit redemption = one race heat covered by one credit. */
export interface CreditRedemption {
  /** BMI personId whose balance is drawn down. */
  personId: string;
  /** Deposit-kind id to deduct from. */
  depositKindId: string;
  /** Stable per-heat reference for idempotency (heatId, else itemId:index). */
  ref: string;
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

/**
 * Derive per-heat credit redemptions from a session: for every race heat whose
 * assigned member is redeeming (carries `redeemCreditKindId`), one credit of that
 * kind is spent — CAPPED at the member's available balance for that kind. A racer
 * with 2 credits but 3 heats redeems 2 heats (the 3rd is paid in cash); they're
 * never charged $0 for more heats than they have credits, and the server validate
 * (count ≤ balance) always passes. Non-transferable: keyed to the assigned
 * member's own bmiPersonId. Heats are walked in session order so this list and
 * `applyCreditRedemptionsToOverview` redeem the SAME heats — displayed == charged.
 */
export function redemptionsFromSession(session: BookingSession): CreditRedemption[] {
  const out: CreditRedemption[] = [];
  // `${personId}:${kindId}` -> credits already spent (cap guard).
  const spent = new Map<string, number>();
  for (const item of session.items) {
    if (item.kind !== "race") continue;
    item.heats.forEach((h, i) => {
      if (!h.assignedTo) return;
      const m = session.party.find((p) => p.id === h.assignedTo);
      if (!m?.bmiPersonId || !m.redeemCreditKindId) return;
      const key = `${m.bmiPersonId}:${m.redeemCreditKindId}`;
      const used = spent.get(key) ?? 0;
      const balance = memberBalanceForKind(m.creditBalances, m.redeemCreditKindId);
      if (used >= balance) return; // out of credits — remaining heats are paid in cash
      spent.set(key, used + 1);
      out.push({
        personId: m.bmiPersonId,
        depositKindId: m.redeemCreditKindId,
        ref: h.heatId ?? `${item.id}:${i}`,
      });
    });
  }
  return out;
}
