/**
 * Booking add-on GRANT rail (server only) — fulfillment for retail add-ons
 * whose catalog entry carries a `grant` (v1: the replacement headsock loads
 * +1 on the racer's Pandora headsock deposit kind, which check-in already
 * detects — "Headsock Due — hand guest a headsock" — and deducts on scan).
 *
 * Runs strictly AFTER the money is verified (race-pack-grant parity). Per
 * selected racer: Redis SET NX guard (a retried reserve can never
 * double-grant) → Pandora addDeposit(personId, kindId, +n) → ledger row
 * marked granted. A failed grant marks the row + enqueues to the EXISTING
 * deposit retry sweep — credits always arrive, so callers NEVER throw the
 * guest's booking away over a grant blip. A racer with NO person id yet
 * (brand-new web racer) parks as `awaiting-person`; the check-in route
 * resolves + grants those (it resolves the person id anyway for headsock
 * detection).
 */
import { addDeposit } from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import redis from "@/lib/redis";
import { getBookingAddon } from "../data/addon-catalog";
import {
  markAddonGranted,
  markAddonGrantFailed,
  markAddonAwaitingPerson,
  type AddonPurchaseIntent,
} from "../data/addon-purchases-db";

/** Add-on credits live on the FastTrax location ledger (race-pack parity). */
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

export interface AddonGrantOutcome {
  slug: string;
  memberId: string;
  /** false = parked (awaiting-person) or handed to the retry sweep. */
  granted: boolean;
}

/** Never throws — the charge already succeeded; failures recover via the
 *  sweep or the check-in awaiting-person resolver. */
export async function grantAddonCredits(args: {
  purchaseKey: string;
  intents: AddonPurchaseIntent[];
}): Promise<AddonGrantOutcome[]> {
  const out: AddonGrantOutcome[] = [];
  for (const it of args.intents) {
    const addon = getBookingAddon(it.addonSlug);
    // Line-item-only add-ons (no grant) have nothing to fulfill.
    if (!addon?.grant || !it.depositKindId || it.grantAmount <= 0) {
      out.push({ slug: it.addonSlug, memberId: it.memberId, granted: true });
      continue;
    }
    if (!it.personId) {
      await markAddonAwaitingPerson(args.purchaseKey, it.memberId, it.addonSlug).catch(() => {});
      console.log(
        `[addon-grant] no person id yet for ${it.memberName ?? it.memberId} (${it.addonSlug}) — awaiting-person`,
      );
      out.push({ slug: it.addonSlug, memberId: it.memberId, granted: false });
      continue;
    }

    const guardKey = `addon-grant:${args.purchaseKey}:${it.memberId}:${it.addonSlug}`;
    try {
      // SET NX — if this add-on already granted (retried reserve), skip.
      const first = await redis.set(guardKey, "1", "EX", 60 * 60 * 24 * 7, "NX");
      if (first !== "OK") {
        console.log(`[addon-grant] already granted, skipping ${guardKey}`);
        out.push({ slug: it.addonSlug, memberId: it.memberId, granted: true });
        continue;
      }
    } catch {
      // Redis unavailable — proceed. A rare double-grant beats a paid-for
      // add-on never arriving; the ledger row keeps the audit trail.
    }

    try {
      const depositId = await addDeposit({
        personId: it.personId,
        depositKindId: it.depositKindId,
        amount: it.grantAmount,
        locationId: FASTTRAX_LOCATION_ID,
      });
      await markAddonGranted(args.purchaseKey, it.memberId, it.addonSlug);
      console.log(
        `[addon-grant] granted ${it.grantAmount} (kind ${it.depositKindId}) to person ${it.personId} (${it.memberName}) → deposit ${depositId}`,
      );
      out.push({ slug: it.addonSlug, memberId: it.memberId, granted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "addDeposit failed";
      console.warn(`[addon-grant] grant failed, enqueueing for retry: ${guardKey}: ${msg}`);
      await markAddonGrantFailed(args.purchaseKey, it.memberId, it.addonSlug, msg).catch(() => {});
      await enqueueDepositFailure({
        source: "addon-headsock",
        sourceRef: `${args.purchaseKey}:${it.memberId}:${it.addonSlug}`,
        locationId: FASTTRAX_LOCATION_ID,
        personId: it.personId,
        depositKindId: it.depositKindId,
        amount: it.grantAmount,
        initialError: msg,
        notes: `Booking add-on ${addon.name} for ${it.memberName ?? it.memberId}`,
      }).catch((e) => console.error(`[addon-grant] enqueue ALSO failed for ${guardKey}:`, e));
      out.push({ slug: it.addonSlug, memberId: it.memberId, granted: false });
    }
  }
  return out;
}
