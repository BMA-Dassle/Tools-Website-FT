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
 * Race step — pick the product for ONE category (adult or junior).
 *
 * v1 parity: race v1 cycles adult product → adult heats → junior product
 * → junior heats. v2 mirrors that with separate StepDef variants
 * (`RaceProductStepAdult` / `RaceProductStepJunior`); each opts into
 * visibility via its `isVisible` checking the party for racers in that
 * category.
 *
 * Each variant filters `race-products.ts` to its category, then further
 * filters by schedule (driven by `item.date`) and the lowest-qualifier
 * rule for the racers in this category (party-wide racerType driven by
 * `isNewRacer` flags — if ANY member is new the party races as new, per
 * v1).
 *
 * Visual: mirrors v1 `ProductPicker.tsx` — tier colors (Starter cyan,
 * Intermediate violet, Pro red), per-card license-fee breakdown for
 * new-racer flows, 3-pack badge when packType=combo.
 *
 * Promo behavior per `booking_v2_promo_integration.md`: filter-at-start
 * only; this step does NOT filter by promo scope. Discount stickers at
 * checkout.
 */

type Category = "adult" | "junior";

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

function racersOfCategory(
  party: { category?: Category; isNewRacer: boolean }[],
  category: Category,
): { category?: Category; isNewRacer: boolean }[] {
  // Treat undefined category as "adult" — matches v1 default + the legacy
  // PartyMember factory's behavior before we surfaced category in the UI.
  return party.filter((m) => (m.category ?? "adult") === category);
}

function makeProductStepComponent(category: Category): StepDef<RaceItem>["Component"] {
  const Component: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
    if (!item.date) {
      return (
        <div className="text-center text-sm text-white/50">
          Pick a date first — that determines which races are available.
        </div>
      );
    }

    const racersInCategory = racersOfCategory(session.party, category);
    const racerCount = racersInCategory.length;
    if (racerCount === 0) {
      // Shouldn't render — step is isVisible-gated — but defensive.
      return (
        <div className="text-center text-sm text-white/50">No {category} racers in this party.</div>
      );
    }

    // Party-wide racerType per v1: if ANY member in this category is a
    // new racer the whole category races as "new" (lowest-qualifier).
    const anyNew = racersInCategory.some((m) => m.isNewRacer);
    const racerType: RacerType = anyNew ? "new" : "existing";

    const products = useMemo(() => {
      const schedule = scheduleForDate(item.date as string);
      const all = productsForSchedule(schedule, racerType);
      return filterProducts(all, {
        racerType,
        adultCount: category === "adult" ? racerCount : 0,
        juniorCount: category === "junior" ? racerCount : 0,
      }).filter((p) => p.category === category);
    }, [item.date, racerType, racerCount]);

    const sorted = [...products].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

    if (products.length === 0) {
      return (
        <div className="text-center text-sm text-white/50">
          No {category} races available for that date. Try a different date.
        </div>
      );
    }

    const selectedProductId = category === "adult" ? item.productIdAdult : item.productIdJunior;
    const setProductId = (productId: string) =>
      onChange(
        category === "adult" ? { productIdAdult: productId } : { productIdJunior: productId },
      );

    return (
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h3 className="font-display text-2xl uppercase tracking-widest text-white">
            {category === "adult" ? "Adult Race" : "Junior Race"}
          </h3>
          <p className="mx-auto max-w-md text-sm text-white/40">
            {racerType === "new"
              ? `First-time ${category}s start here. Pick the race that fits your group.`
              : `Select a race your ${category}s have qualified for.`}
          </p>
        </div>

        <div className="grid gap-3">
          {sorted.map((product) => (
            <ProductCard
              key={product.productId}
              product={product}
              isSelected={selectedProductId === product.productId}
              onSelect={() => setProductId(product.productId)}
              racerType={racerType}
              racerCount={racerCount}
            />
          ))}
        </div>
      </div>
    );
  };
  return Component;
}

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
        <span className="text-sm font-bold whitespace-nowrap text-white">
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

function hasCategory(session: { party: { category?: Category }[] }, category: Category): boolean {
  return session.party.some((m) => (m.category ?? "adult") === category);
}

export const RaceProductStepAdult: StepDef<RaceItem> = {
  id: "race-product-adult",
  title: "Adult Race",
  Component: makeProductStepComponent("adult"),
  isVisible: (_item, session) => hasCategory(session, "adult"),
  canAdvance: (item, session) => {
    if (!hasCategory(session, "adult")) return true;
    return item.productIdAdult ? true : { reason: "Pick an adult race to continue." };
  },
};

export const RaceProductStepJunior: StepDef<RaceItem> = {
  id: "race-product-junior",
  title: "Junior Race",
  Component: makeProductStepComponent("junior"),
  isVisible: (_item, session) => hasCategory(session, "junior"),
  canAdvance: (item, session) => {
    if (!hasCategory(session, "junior")) return true;
    return item.productIdJunior ? true : { reason: "Pick a junior race to continue." };
  },
};
