/**
 * Kiosk race-pack GRANT rail (server only) — shared by both surfaces
 * (in-booking day-of line + the standalone attract-screen flow).
 *
 * Runs strictly AFTER the money is verified. Per pack: Redis SET NX guard
 * (a retried reserve/finalize can never double-grant) → Pandora
 * addDeposit(personId, kindId, +raceCount) → ledger row marked granted.
 * A failed grant marks the row + enqueues to the EXISTING deposit retry
 * sweep (same recovery rail race-credit redemptions use) — credits always
 * arrive, so callers NEVER throw the guest's booking away over a grant blip.
 */
import { addDeposit } from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import redis from "@/lib/redis";
import type { ResolvedKioskPack } from "./race-pack-kiosk";
import { markPackGranted, markPackGrantFailed } from "../data/race-pack-purchases-db";

/** Race credits live on the FastTrax location ledger (race-credit-redeem parity). */
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

export interface PackGrantOutcome {
  slug: string;
  memberId: string;
  /** false = the retry sweep owns it now ("credits will appear in a few minutes"). */
  granted: boolean;
}

/** Never throws — the charge already succeeded; failures recover via the sweep. */
export async function grantKioskRacePacks(args: {
  purchaseKey: string;
  packs: ResolvedKioskPack[];
}): Promise<PackGrantOutcome[]> {
  const out: PackGrantOutcome[] = [];
  for (const p of args.packs) {
    const guardKey = `race-pack:${args.purchaseKey}:${p.personId}:${p.slug}`;
    try {
      // SET NX — if this pack already granted (retried finalize), skip.
      const first = await redis.set(guardKey, "1", "EX", 60 * 60 * 24 * 7, "NX");
      if (first !== "OK") {
        console.log(`[race-pack] already granted, skipping ${guardKey}`);
        out.push({ slug: p.slug, memberId: p.memberId, granted: true });
        continue;
      }
    } catch {
      // Redis unavailable — proceed. A rare double-grant beats a paid-for pack
      // never arriving; the ledger row keeps the audit trail either way.
    }

    try {
      const depositId = await addDeposit({
        personId: p.personId,
        depositKindId: p.pack.depositKindId,
        amount: p.pack.raceCount,
        locationId: FASTTRAX_LOCATION_ID,
      });
      await markPackGranted(args.purchaseKey, p.personId, p.slug);
      console.log(
        `[race-pack] granted ${p.pack.raceCount} (kind ${p.pack.depositKindId}) to person ${p.personId} (${p.memberName}) → deposit ${depositId}`,
      );
      out.push({ slug: p.slug, memberId: p.memberId, granted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "addDeposit failed";
      console.warn(`[race-pack] grant failed, enqueueing for retry: ${guardKey}: ${msg}`);
      await markPackGrantFailed(args.purchaseKey, p.personId, p.slug, msg).catch(() => {});
      await enqueueDepositFailure({
        source: "race-pack-kiosk",
        sourceRef: `${args.purchaseKey}:${p.personId}:${p.slug}`,
        locationId: FASTTRAX_LOCATION_ID,
        personId: p.personId,
        depositKindId: p.pack.depositKindId,
        amount: p.pack.raceCount,
        initialError: msg,
        notes: `Kiosk race pack ${p.label} for ${p.memberName}`,
      }).catch((e) => console.error(`[race-pack] enqueue ALSO failed for ${guardKey}:`, e));
      out.push({ slug: p.slug, memberId: p.memberId, granted: false });
    }
  }
  return out;
}
