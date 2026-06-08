/**
 * Race-credit redemption — server-side validate + deduct.
 *
 * When a returning racer (or linked family member) redeems a race credit in the
 * v2 $0 model, Square charges $0 for that race and we explicitly draw down one
 * BMI deposit credit (the $0 build product means BMI no longer auto-applies it).
 *
 *   - validateCreditRedemptions(): charge-time re-eval. Re-fetch the racer's live
 *     balance and confirm each chosen kind still has enough. Throws
 *     CreditRedemptionError on mismatch — call BEFORE charging so we never charge
 *     (or give a free race) on a stale balance.
 *   - deductCreditRedemptions(): after the booking is confirmed, deduct one credit
 *     per redeemed heat via Pandora `addDeposit(-1)`. Idempotent per heat (Redis
 *     NX guard); failures enqueue to the deposit retry sweep so the credit is
 *     eventually drawn down. Never throws — the booking already succeeded.
 *
 * Mirrors the deduction recipe used by POV claims + headsock check-in.
 */
import { getDepositBalances, addDeposit } from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import redis from "@/lib/redis";
import { creditTypeById, type CreditRedemption } from "../data/race-credits";

/** Race credits live on the FastTrax location ledger. */
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

export class CreditRedemptionError extends Error {
  code = "CREDIT_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "CreditRedemptionError";
  }
}

/**
 * Charge-time re-eval. Re-fetch each racer's live deposit balances and confirm
 * the chosen kind(s) still cover the number of heats being redeemed. Throws
 * CreditRedemptionError if any racer no longer has enough — caller must abort the
 * booking before charging.
 */
export async function validateCreditRedemptions(
  redemptions: CreditRedemption[],
  locationId: string = FASTTRAX_LOCATION_ID,
): Promise<void> {
  if (!redemptions.length) return;

  // needed[personId][depositKindId] = count of heats
  const needed = new Map<string, Map<string, number>>();
  for (const r of redemptions) {
    const perKind = needed.get(r.personId) ?? new Map<string, number>();
    perKind.set(r.depositKindId, (perKind.get(r.depositKindId) ?? 0) + 1);
    needed.set(r.personId, perKind);
  }

  for (const [personId, perKind] of needed) {
    let balances: Map<string, { name: string; balance: number }>;
    try {
      balances = await getDepositBalances(personId, locationId);
    } catch {
      throw new CreditRedemptionError(
        "Couldn't verify your race credit balance right now. Please try again.",
      );
    }
    for (const [depositKindId, count] of perKind) {
      const have = balances.get(depositKindId)?.balance ?? 0;
      if (have < count) {
        const label = creditTypeById(depositKindId)?.label ?? "race credit";
        throw new CreditRedemptionError(
          `Not enough ${label} available (need ${count}, have ${have}). Please refresh and try again.`,
        );
      }
    }
  }
}

/**
 * Deduct one credit per redeemed heat. Idempotent per (billId, heat, kind) via a
 * Redis NX guard so a retried reserve can't double-deduct. A failed deduct is
 * enqueued to the retry sweep (source "race-credit-redeem"). Never throws.
 */
export async function deductCreditRedemptions(
  redemptions: CreditRedemption[],
  opts: { billId: string; locationId?: string },
): Promise<void> {
  if (!redemptions.length) return;
  const locationId = opts.locationId ?? FASTTRAX_LOCATION_ID;

  for (const r of redemptions) {
    const guardKey = `race-credit-redeemed:${opts.billId}:${r.ref}:${r.depositKindId}`;
    try {
      // SET NX — if this heat's credit was already drawn down, skip (retry-safe).
      const first = await redis.set(guardKey, "1", "EX", 60 * 60 * 24 * 7, "NX");
      if (first !== "OK") {
        console.log(`[race-credit-redeem] already applied, skipping ${guardKey}`);
        continue;
      }
    } catch {
      // Redis unavailable — proceed with the deduct. Deducting once on a rare
      // double-call is far better than silently giving away a free race.
    }

    try {
      const depositId = await addDeposit({
        personId: r.personId,
        depositKindId: r.depositKindId,
        amount: -1,
        locationId,
      });
      console.log(
        `[race-credit-redeem] deducted 1 (kind ${r.depositKindId}) from person ${r.personId} → deposit ${depositId}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "addDeposit failed";
      console.warn(`[race-credit-redeem] deduct failed, enqueueing for retry: ${msg}`);
      await enqueueDepositFailure({
        source: "race-credit-redeem",
        sourceRef: `${opts.billId}:${r.ref}:${r.depositKindId}`,
        locationId,
        personId: r.personId,
        depositKindId: r.depositKindId,
        amount: -1,
        initialError: msg,
        notes: `Race credit redemption on bill ${opts.billId}`,
      });
    }
  }
}
