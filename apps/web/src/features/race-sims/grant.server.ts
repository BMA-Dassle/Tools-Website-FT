/**
 * Race Sim PACK grant rail (server only).
 *
 * A sim pack is a PREPAID CREDIT BUNDLE, not a booking: one price buys N sim
 * credits onto the buyer's Pandora ledger, spent later at $0 a session. This
 * is the karting race-pack rail (service/race-pack-grant.server.ts) with one
 * deliberate difference — its OWN deposit kind ("Credit - Race Simulator",
 * 61079628). A kart credit must never spend on a sim, or the reverse.
 *
 * Runs strictly AFTER the money is verified, and NEVER throws: the charge has
 * already succeeded, so a grant blip must not throw the guest's booking away.
 * Per pack: Redis SET NX guard (a retried reserve can never double-grant) →
 * Pandora addDeposit(+raceCount) → on failure, hand it to the SAME deposit
 * retry sweep the race-credit rail uses, so credits always arrive.
 */
import { addDeposit } from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";
import redis from "@/lib/redis";
import { getRaceSimProduct } from "./products";

/** Sim credits live on the FastTrax location ledger — race-credit parity. */
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

export interface RaceSimPackGrant {
  /** RACE_SIM_PRODUCTS slug, e.g. "sim-3-pack". */
  slug: string;
  /** Pandora person the credits land on. */
  personId: string;
  /** For the log line only. */
  personName?: string | null;
}

export interface RaceSimGrantOutcome {
  slug: string;
  personId: string;
  /** Credits actually granted (the pack's raceCount). */
  credits: number;
  /** false = the retry sweep owns it now — "credits appear in a few minutes". */
  granted: boolean;
}

/**
 * Grant every purchased sim pack. Never throws.
 *
 * `purchaseKey` must be stable per charge (the BMI bill id is what callers
 * pass), because it is what makes the Redis guard idempotent across a retried
 * reserve — the difference between a guest getting 3 credits and 6.
 */
export async function grantRaceSimPacks(args: {
  purchaseKey: string;
  packs: RaceSimPackGrant[];
}): Promise<RaceSimGrantOutcome[]> {
  const out: RaceSimGrantOutcome[] = [];
  for (const p of args.packs) {
    const product = getRaceSimProduct(p.slug);
    const kindId = product?.depositKindId ?? null;
    // Both are guard-2e invariants by the time we get here; if either is
    // somehow missing, say so loudly rather than silently granting nothing.
    if (!product || product.kind !== "pack" || !kindId) {
      console.error(`[race-sim-pack] refusing to grant ${p.slug}: not an armed pack`);
      out.push({ slug: p.slug, personId: p.personId, credits: 0, granted: false });
      continue;
    }

    const guardKey = `race-sim-pack:${args.purchaseKey}:${p.personId}:${p.slug}`;
    try {
      const first = await redis.set(guardKey, "1", "EX", 60 * 60 * 24 * 7, "NX");
      if (first !== "OK") {
        console.log(`[race-sim-pack] already granted, skipping ${guardKey}`);
        out.push({ slug: p.slug, personId: p.personId, credits: product.raceCount, granted: true });
        continue;
      }
    } catch {
      // Redis down — proceed. A rare double-grant beats a paid-for pack never
      // arriving, and the Pandora ledger keeps the audit trail either way.
    }

    try {
      const depositId = await addDeposit({
        personId: p.personId,
        depositKindId: kindId,
        amount: product.raceCount,
        locationId: FASTTRAX_LOCATION_ID,
      });
      console.log(
        `[race-sim-pack] granted ${product.raceCount} (kind ${kindId}) to person ${p.personId}` +
          `${p.personName ? ` (${p.personName})` : ""} → deposit ${depositId}`,
      );
      out.push({ slug: p.slug, personId: p.personId, credits: product.raceCount, granted: true });
    } catch (err) {
      console.error(`[race-sim-pack] grant FAILED for ${p.personId} / ${p.slug}:`, err);
      // Hand it to the existing sweep rather than dropping it — the guest has
      // paid, so the only acceptable end state is "credits arrive".
      await enqueueDepositFailure({
        source: "race-pack",
        sourceRef: `race-sim-pack:${args.purchaseKey}:${p.personId}:${p.slug}`,
        personId: p.personId,
        depositKindId: kindId,
        amount: product.raceCount,
        locationId: FASTTRAX_LOCATION_ID,
        initialError: err instanceof Error ? err.message : String(err),
        notes: `Race Sim pack ${p.slug} — ${product.raceCount} sim credits`,
      }).catch((e) => console.error("[race-sim-pack] enqueue failed too:", e));
      out.push({ slug: p.slug, personId: p.personId, credits: product.raceCount, granted: false });
    }
  }
  return out;
}
