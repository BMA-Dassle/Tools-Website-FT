"use client";

import { useEffect, useState } from "react";
import {
  type PackageDefinition,
  packageLoosestGapMinutes,
  primaryTrack,
} from "~/features/booking/service/packages";
import { LICENSE_PRICE, POV_PRICE } from "~/features/booking/service/race-pricing";
import { bmiAdapter } from "~/features/booking/data/bmi";
import { violatesMinGapAfter } from "~/features/booking/service/conflict";

/**
 * Live package availability + the two derivations every package surface must
 * share (PackageCard on the product step, the pay-mode page's bundle rows) —
 * one fetch shape, one price math, one blocked rule, so no surface can quote
 * a package differently from what checkout charges.
 */

export interface HeatTime {
  start: string;
  stop: string;
}

/**
 * Multi-race gate: a package with a min-gap rule (the Ultimate Qualifier's
 * Intermediate after the Starter) is a dead-end late at night when no
 * Starter→Intermediate pair fits even at that package's LOOSEST gap. Callers
 * disable the card/row with a reason instead of letting the customer pick a
 * Starter that can't be paired. The floor is derived per package, never
 * hardcoded: a literal here has to be re-checked every time a variant's
 * relaxation moves, and if it is ever stricter than the real rule this greys
 * out a card the heat picker would still book (near-miss 2026-08-04, Mega at
 * 20). Null heats (fetch not finished) → not blocked.
 */
export function packageBlockedToday(
  pkg: PackageDefinition,
  heatsByRef: Record<string, HeatTime[]> | null,
): boolean {
  const gateRace = pkg.races.find((r) => r.minMinutesAfterEndOf);
  if (!gateRace?.minMinutesAfterEndOf || !heatsByRef) return false;
  const prev = heatsByRef[gateRace.minMinutesAfterEndOf.ref] ?? [];
  const next = heatsByRef[gateRace.ref] ?? [];
  if (prev.length === 0 || next.length === 0) return true;
  const loosest = packageLoosestGapMinutes(gateRace);
  const fits = prev.some((p) => next.some((n) => !violatesMinGapAfter(p.stop, n.start, loosest)));
  return !fits;
}

/**
 * Per-racer price from the LIVE availability read — race components at their
 * live cash price (registry price when a component's read failed), plus the
 * bundled license/POV at the shared constants. (The previous inline copy in
 * PackageCard hardcoded POV at $5 after the constant moved to $4.99 — the
 * exact drift these constants exist to prevent.)
 */
export function livePerRacerPrice(
  pkg: PackageDefinition,
  livePrices: Record<string, number>,
): number {
  // A bundle that PINS its own price is sold at that price, full stop — live
  // component prices describe what the pieces cost separately, which is exactly
  // what a fixed-price bundle is defined as NOT charging.
  //
  // This mirrors `packagePerRacerPrice`, which short-circuits on `pkg.price`
  // for the same reason. The two must agree: the charge path reads the registry
  // helper, this one only ever feeds the screen. When they diverged, the BOGO
  // flash sale rendered at $39.99 (the summed components) while checkout
  // charged the pinned $20.99 — displayed != charged, and the deal read as a
  // markup with a "+$14.01" delta against a plain single race.
  if (typeof pkg.price === "number") return pkg.price;
  return (
    pkg.races.reduce((sum, r) => sum + (livePrices[r.ref] ?? primaryTrack(r).price), 0) +
    (pkg.includesLicense ? LICENSE_PRICE : 0) +
    (pkg.includesPov ? POV_PRICE : 0)
  );
}

export function usePackageAvailability(
  pkg: PackageDefinition,
  date: string | null,
  racers: number,
): {
  livePrices: Record<string, number> | null;
  heatsByRef: Record<string, HeatTime[]> | null;
  loading: boolean;
} {
  const [livePrices, setLivePrices] = useState<Record<string, number> | null>(null);
  const [heatsByRef, setHeatsByRef] = useState<Record<string, HeatTime[]> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!date || pkg.races.length === 0) return;
    let cancelled = false;
    setLoading(true);

    (async () => {
      const prices: Record<string, number> = {};
      const heats: Record<string, HeatTime[]> = {};
      for (const race of pkg.races) {
        const track = primaryTrack(race);
        try {
          const avail = await bmiAdapter.getAvailability({
            date,
            productId: track.productId,
            pageId: track.pageId,
            quantity: Math.max(1, racers),
          });
          const blocks = (avail.proposals ?? [])
            .map((p) => p.blocks?.[0]?.block)
            .filter((b): b is NonNullable<typeof b> => Boolean(b));
          heats[race.ref] = blocks.map((b) => ({ start: b.start, stop: b.stop }));
          const cashPrice = blocks[0]?.prices?.find((p) => p.depositKind === 0);
          if (cashPrice) {
            prices[race.ref] = cashPrice.amount;
          }
        } catch {
          heats[race.ref] = heats[race.ref] ?? [];
        }
      }
      if (!cancelled) {
        setLivePrices(Object.keys(prices).length > 0 ? prices : null);
        setHeatsByRef(heats);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [date, pkg.id, pkg.races, racers]);

  return { livePrices, heatsByRef, loading };
}
