"use client";

import { useMemo } from "react";
import type { RaceItem, StepDef } from "~/features/booking";
import {
  filterProducts,
  productsForSchedule,
  type RaceProduct,
  type RaceTier,
  type RacerType,
} from "~/features/booking/service/race-products";
import { scheduleForDate, LICENSE_PRICE } from "~/features/booking/service/race-pricing";

/**
 * Race step — pick the product (tier × track or combo pack).
 *
 * Filters available products from `race-products.ts` against:
 *   - `item.date` (drives schedule: weekday / weekend / mega-Tuesday)
 *   - `session.party`'s adult / junior counts (drives category filter)
 *   - `session.party`'s isNewRacer flag (drives Starter-only filter for
 *     parties with at least one first-timer)
 *
 * Mirrors v1 `ProductPicker.tsx` visual:
 *   - Centered title (font-display uppercase tracking-widest)
 *   - Cards grouped by tier (Starter cyan, Intermediate violet, Pro red)
 *   - Per-card: tier badge, name, racer-count math + license-fee
 *     breakdown for new-racer flows, 3-pack badge when packType=combo
 *
 * Promo behavior per `booking_v2_promo_integration.md`: filtration only
 * at the start; the product step does NOT filter by promo scope. The
 * discount sticks to matching lines at checkout, regardless of which
 * products the customer picks.
 */

const TIER_COLOR: Record<RaceTier, { border: string; bg: string; badge: string; text: string }> = {
  starter: {
    border: "border-[#00E2E5]",
    bg: "bg-[#00E2E5]/10",
    badge: "bg-[#00E2E5]/20 text-[#00E2E5]",
    text: "text-[#00E2E5]",
  },
  intermediate: {
    border: "border-[#8652FF]",
    bg: "bg-[#8652FF]/10",
    badge: "bg-[#8652FF]/20 text-[#8652FF]",
    text: "text-[#8652FF]",
  },
  pro: {
    border: "border-[#E53935]",
    bg: "bg-[#E53935]/10",
    badge: "bg-[#E53935]/20 text-[#E53935]",
    text: "text-[#E53935]",
  },
};

const TIER_LABEL: Record<RaceTier, string> = {
  starter: "Starter",
  intermediate: "Intermediate",
  pro: "Pro",
};

const TIER_ORDER: Record<RaceTier, number> = { starter: 0, intermediate: 1, pro: 2 };

const RaceProductStepComponent: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
  // Defensive: if Date step was skipped, prompt to back up.
  if (!item.date) {
    return (
      <div className="text-center text-sm text-white/50">
        Pick a date first — that determines which races are available.
      </div>
    );
  }

  const adultCount = session.party.filter((m) => m.category !== "junior").length;
  const juniorCount = session.party.filter((m) => m.category === "junior").length;
  // If ANY party member is a new racer, the party as a whole races as
  // new — v1 race wizard enforces the same lowest-qualifier rule.
  const anyNew = session.party.some((m) => m.isNewRacer);
  const racerType: RacerType = anyNew ? "new" : "existing";
  const racerCount = Math.max(1, adultCount + juniorCount);

  const products = useMemo(() => {
    const schedule = scheduleForDate(item.date as string);
    const all = productsForSchedule(schedule, racerType);
    return filterProducts(all, { racerType, adultCount, juniorCount });
  }, [item.date, racerType, adultCount, juniorCount]);

  // Group products that share name+tier+category but differ by track —
  // these were per-track variants in v1. v2 collapses them into one
  // card and lets the heat picker pick the track. For PR-B2 commit 9b
  // we keep the simple flat list; the multi-track 3-packs already
  // collapse via `trackProducts` on their parent entry.
  const byTierThenCategory = [...products].sort((a, b) => {
    const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (t !== 0) return t;
    const catA = a.category === "junior" ? 1 : 0;
    const catB = b.category === "junior" ? 1 : 0;
    return catA - catB;
  });

  if (products.length === 0) {
    return (
      <div className="text-center text-sm text-white/50">
        No races available for that date + party. Try a different date or adjust your party.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h3 className="font-display text-2xl uppercase tracking-widest text-white">
          {racerType === "new" ? "Pick Your Starter Race" : "Choose Your Race"}
        </h3>
        <p className="mx-auto max-w-md text-sm text-white/40">
          {racerType === "new"
            ? "All first-time racers start here. Pick the race that fits your group."
            : "Select a race you've qualified for."}
        </p>
      </div>

      <div className="grid gap-3">
        {byTierThenCategory.map((product) => (
          <ProductCard
            key={product.productId}
            product={product}
            isSelected={item.productId === product.productId}
            onSelect={() => onChange({ productId: product.productId })}
            racerType={racerType}
            racerCount={racerCount}
          />
        ))}
      </div>
    </div>
  );
};

function ProductCard({
  product,
  isSelected,
  onSelect,
  racerType,
  racerCount,
}: {
  product: RaceProduct;
  isSelected: boolean;
  onSelect: () => void;
  racerType: RacerType;
  racerCount: number;
}) {
  const c = TIER_COLOR[product.tier];
  const tierLabel = TIER_LABEL[product.tier];
  const isPack = product.packType === "combo";
  const racers = Math.max(1, racerCount);

  // For new racers picking a single race, the bill auto-adds a license
  // per racer at checkout. Break the math out so the headline price
  // matches what they'll actually be charged — same UX as v1.
  const isSinglePerPersonRace = !isPack && product.price > 0;
  const showNewBreakdown = isSinglePerPersonRace && racerType === "new";
  const licensePerRacer = showNewBreakdown ? LICENSE_PRICE : 0;
  const perRacerTotal = product.price + licensePerRacer;
  const groupTotal = perRacerTotal * racers;

  const baseClasses = "text-left rounded-xl border p-4 transition-all duration-200 w-full";
  const selectedClasses = `${c.border} ${c.bg} ring-2 ring-offset-2 ring-offset-[#010A20]`;
  const packClasses =
    "border-amber-500/20 bg-amber-500/5 hover:border-amber-500/40 hover:bg-amber-500/10";
  const regularClasses = "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/8";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`${baseClasses} ${isSelected ? selectedClasses : isPack ? packClasses : regularClasses}`}
    >
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-white">{product.name}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${c.badge}`}>
            {tierLabel}
          </span>
          {isPack && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-400">
              {product.raceCount}-Race Pack
            </span>
          )}
        </div>
        <span className="text-sm font-bold text-white whitespace-nowrap">
          ${product.price.toFixed(2)}
          {!isPack && <span className="text-xs text-white/40"> / racer</span>}
        </span>
      </div>

      {showNewBreakdown && (
        <div className="mt-2 text-xs text-white/50">
          + ${LICENSE_PRICE.toFixed(2)} first-time license per racer ·{" "}
          <span className="text-white/70">
            ${perRacerTotal.toFixed(2)} / racer × {racers} = ${groupTotal.toFixed(2)} total
          </span>
        </div>
      )}
      {!showNewBreakdown && !isPack && racers > 1 && (
        <div className="mt-2 text-xs text-white/50">
          ${product.price.toFixed(2)} × {racers} racers = ${(product.price * racers).toFixed(2)}{" "}
          total
        </div>
      )}
      {isPack && (
        <div className="mt-2 text-xs text-white/50">
          {product.raceCount} heats on one bill · pick your heat times next.
        </div>
      )}
    </button>
  );
}

export const RaceProductStep: StepDef<RaceItem> = {
  id: "race-product",
  title: "Product",
  Component: RaceProductStepComponent,
  isVisible: () => true,
  canAdvance: (item) => (item.productId ? true : { reason: "Pick a race to continue." }),
};
