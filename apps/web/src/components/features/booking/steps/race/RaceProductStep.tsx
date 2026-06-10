"use client";

import { useMemo } from "react";
import type { RaceItem, StepDef } from "~/features/booking";
import { membershipDiscountsForNames } from "~/features/booking/service/membership-discounts";
import {
  filterProducts,
  productsForSchedule,
  combineTrackVariants,
  type RaceProduct,
  type RaceTier,
  type RacerType,
} from "~/features/booking/service/race-products";
import { scheduleForDate, LICENSE_PRICE } from "~/features/booking/service/race-pricing";
import { eligiblePackages } from "~/features/booking/service/packages";
import { PackageCard } from "./PackageCard";

/**
 * Race step — pick the product for ONE category (adult or junior).
 *
 * v1 parity: full port of `apps/web/app/book/race/components/ProductPicker.tsx`.
 * Mirrors:
 *   - Title differs by racerType: "Pick Your Starter Race" (new) vs
 *     "Choose Your Race" (existing)
 *   - Tier descriptions render under name + tier label
 *   - Multi-track products (parent has `trackProducts`) collapse to a single
 *     merged card; selecting one shows BOTH tracks on the heat grid (no track
 *     lock, like the Ultimate combo) — the customer picks any heat regardless
 *     of track
 *   - Per-card itemized breakdown for new-racer single-race picks
 *     (race + license × racers = total)
 *   - 3-pack badge + "$X / race" footnote for combo packs
 *   - "No races available for this date and party" empty state
 *
 * NOT yet ported (deferred follow-up commits flagged at PR review):
 *   - Premium Packages (`PackageDefinition` from `lib/packages.ts`) —
 *     needs the full packages registry + live BMI pricing port. The
 *     v2 race step ships without bundled packages; customers still get
 *     individual races + 3-packs.
 *   - "Showing tier and below" qualification banner — depends on
 *     per-racer BMI verification data (the verification flow is a
 *     deferred follow-up PR, so the data source doesn't exist yet).
 *
 * Promo behavior per `booking_v2_promo_integration.md`: filter-at-start
 * only; this step does NOT filter by promo scope. Discount sticks at
 * checkout regardless of product picked.
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

// Verbatim copy from v1 data.ts:1022-1028 — keep in sync if v1 edits.
const TIER_DESCRIPTIONS: Record<RaceTier, string> = {
  starter:
    "Everyone must start at our Starter speed — a fun, exciting race meant for everyone on either track. Being your first visit, you'll also purchase a FastTrax license which includes use of helmets, FastTrax app tracking, head sock, waived booking fees, and more.",
  intermediate:
    "Higher speed unlock — not for the faint of heart. A real competitive karting experience. Qualified from Starter. Ages 13+.",
  pro: "Our fastest unlocked speed. Maximum performance for racers who've proven their skill.",
};

const TIER_ORDER: Record<RaceTier, number> = { starter: 0, intermediate: 1, pro: 2 };

const TRACK_BADGE: Record<string, { bg: string; text: string }> = {
  Red: { bg: "bg-red-500/20", text: "text-red-400" },
  Blue: { bg: "bg-blue-500/20", text: "text-blue-400" },
  Mega: { bg: "bg-[#A855F7]/20", text: "text-[#C084FC]" },
};

function racersOfCategory(
  party: { category?: Category; isNewRacer: boolean; memberships?: string[] }[],
  category: Category,
): { category?: Category; isNewRacer: boolean; memberships?: string[] }[] {
  return party.filter((m) => (m.category ?? "adult") === category);
}

function isMultiTrack(product: RaceProduct): boolean {
  return !!product.trackProducts && Object.keys(product.trackProducts).length > 1;
}

function groupByTier(products: RaceProduct[]): [RaceTier, RaceProduct[]][] {
  const groups = new Map<RaceTier, RaceProduct[]>();
  for (const p of products) {
    const list = groups.get(p.tier) ?? [];
    list.push(p);
    groups.set(p.tier, list);
  }
  return [...groups.entries()].sort(([a], [b]) => TIER_ORDER[a] - TIER_ORDER[b]);
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
      return (
        <div className="text-center text-sm text-white/50">No {category} racers in this party.</div>
      );
    }

    // racerType drives the product SET + tier gating. Use the NEW-racer flow
    // (Starter only + license bundle) ONLY when EVERY racer is new. A MIXED party
    // (e.g. a returning Pro racer + a new racer) uses the EXISTING flow so the
    // list spans every tier up to the highest-qualifying racer's rating. The new
    // racer still gets their license (added per `isNewRacer` at charge/book time)
    // and is crossed out of any heat above Starter in the racer selector.
    const allNew = racersInCategory.every((m) => m.isNewRacer);
    const racerType: RacerType = allNew ? "new" : "existing";

    // Aggregate memberships across this category's verified racers. v1
    // `filterProducts` gates Intermediate/Pro tier visibility on whether
    // the party has any member with that membership — so we pass the
    // union of every category racer's memberships. Without this, the
    // returning-racer flow defaults to Starter-only, hiding 3-Packs
    // and higher-tier products.
    const memberships = racersInCategory.flatMap((m) => m.memberships ?? []);

    // Heats already added for this category (via the "Add another race" loop, which
    // returns here with the product cleared). Drives the continue/add-more banner.
    const categoryHeatCount = item.heats.filter((h) => {
      if (!h.heatId || !h.assignedTo) return false;
      const m = session.party.find((p) => p.id === h.assignedTo);
      return !!m && (m.category ?? "adult") === category;
    }).length;

    const products = useMemo(() => {
      const schedule = scheduleForDate(item.date as string);
      const all = productsForSchedule(schedule, racerType);
      const filtered = filterProducts(all, {
        racerType,
        adultCount: category === "adult" ? racerCount : 0,
        juniorCount: category === "junior" ? racerCount : 0,
        memberships,
      }).filter((p) => p.category === category);
      // Collapse Red+Blue single races into one combined card — the heat grid
      // then shows BOTH tracks (like the Ultimate combo). Combos, single-track
      // (Mega) and junior (Blue-only) pass through unchanged.
      return combineTrackVariants(filtered);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item.date, racerType, racerCount, memberships.join("|")]);

    const sorted = [...products].sort((a, b) => {
      const ta = TIER_ORDER[a.tier];
      const tb = TIER_ORDER[b.tier];
      if (ta !== tb) return ta - tb;
      return (a.raceCount ?? 1) - (b.raceCount ?? 1);
    });

    const packages = useMemo(() => {
      const schedule = scheduleForDate(item.date as string);
      return eligiblePackages({ racerType, schedule, category });
    }, [item.date, racerType]);

    // Package selection lives on item.packageId so back-nav doesn't lose it
    // AND so saveBookingDetails can write it to /api/booking-record (which
    // feeds sales_log.package_id via the v1 confirmation page).
    const selectedPackageId = item.packageId;

    const selectedProductId = category === "adult" ? item.productIdAdult : item.productIdJunior;
    const selectedTrack = category === "adult" ? item.productTrackAdult : item.productTrackJunior;

    const setProductWithTrack = (productId: string, track: string | null) =>
      onChange(
        category === "adult"
          ? { productIdAdult: productId, productTrackAdult: track }
          : { productIdJunior: productId, productTrackJunior: track },
      );

    const handleCardClick = (product: RaceProduct) => {
      // Multi-track products — combined single races AND mixed-track combo packs
      // (3-Packs) — are NOT track-locked: selecting one leaves the track open so
      // the heat grid shows BOTH tracks (like the Ultimate combo) and the customer
      // picks any heat(s) regardless of track. Single-track products carry theirs.
      if (isMultiTrack(product)) {
        setProductWithTrack(product.productId, null);
        return;
      }
      setProductWithTrack(product.productId, product.track);
    };

    if (products.length === 0) {
      return (
        <div className="py-8 text-center">
          <p className="text-sm text-white/40">
            No races available for this date and party. Try a different date.
          </p>
        </div>
      );
    }

    // Show category banner when the party spans BOTH adults + juniors
    // so the customer knows which side of the wizard they're on. v1
    // surfaces this same banner (page.tsx:2107-2138) above ProductPicker;
    // we dropped it during the strict-parity reverts but it's needed
    // when there's any chance of category confusion.
    const hasAdults = session.party.some((m) => (m.category ?? "adult") === "adult");
    const hasJuniors = session.party.some((m) => m.category === "junior");
    const showCategoryBanner = hasAdults && hasJuniors;

    // Per-racer membership racing discount (e.g. Employee Pass 50%, League Racer
    // 20%) — shown only for the racers in THIS category who hold it; others on
    // the bill aren't discounted. Applied for real at checkout (charge-line split).
    const discountRacers = session.party
      .filter((m) => (m.category ?? "adult") === category)
      .map((m) => {
        let pct = 0;
        let label: string | null = null;
        for (const d of membershipDiscountsForNames(m.memberships ?? [])) {
          if (d.categories.includes("racing") && d.percentOff > pct) {
            pct = d.percentOff;
            label = d.label;
          }
        }
        return pct > 0 ? { name: m.firstName, pct, label } : null;
      })
      .filter((x): x is { name: string; pct: number; label: string | null } => x != null);

    return (
      <div className="space-y-6">
        {showCategoryBanner && (
          <div
            className={`rounded-xl border-2 p-4 text-center ${
              category === "adult"
                ? "border-[#00E2E5]/50 bg-[#00E2E5]/10"
                : "border-amber-400/50 bg-amber-400/10"
            }`}
          >
            <p
              className={`font-display text-xl uppercase tracking-widest ${
                category === "adult" ? "text-[#00E2E5]" : "text-amber-400"
              }`}
            >
              {category === "adult" ? "Adult Races" : "Junior Races"}
            </p>
            <p className="mt-1 text-sm text-white/50">
              Pick a race for your {racerCount} {category}
              {racerCount !== 1 ? " racers" : " racer"}
            </p>
          </div>
        )}

        <div className="space-y-2 text-center">
          {/* v1 ProductPicker:121-130 verbatim — same titles for adult + junior */}
          <h3 className="font-display text-2xl tracking-widest text-white uppercase">
            {racerType === "new" ? "Pick Your Starter Race" : "Choose Your Race"}
          </h3>
          <p className="mx-auto max-w-md text-sm text-white/40">
            {racerType === "new"
              ? "All first-time racers start here. Pick the race that fits your group."
              : "Select from races you've qualified for."}
          </p>
        </div>

        {discountRacers.length > 0 && (
          <div className="mx-auto max-w-md space-y-1 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-center text-sm text-amber-300">
            {discountRacers.map((r) => (
              <p key={r.name}>
                🏁 <span className="font-semibold">{r.label ?? "Member"}</span>: {r.pct}% off{" "}
                {r.name}&apos;s races — applied at checkout
              </p>
            ))}
          </div>
        )}

        {categoryHeatCount > 0 && (
          <div className="mx-auto max-w-md rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 p-3 text-center text-sm text-[#00E2E5]">
            You&apos;ve added {categoryHeatCount} {category} race
            {categoryHeatCount === 1 ? "" : "s"} — pick another below to add more, or hit Continue
            to move on.
          </div>
        )}

        {packages.length > 0 && (
          <div className="space-y-3">
            {packages.map((pkg) => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                racerCount={racerCount}
                date={item.date}
                isSelected={selectedPackageId === pkg.id}
                onSelect={() => {
                  // Persist the package pick on item state so back-nav
                  // doesn't lose it + so saveBookingDetails forwards it
                  // to the booking-record (drives sales_log.package_id).
                  // Clearing individual product pick keeps the cart shape
                  // consistent — package picks own their own race selections.
                  onChange(
                    category === "adult"
                      ? {
                          packageId: pkg.id,
                          productIdAdult: null,
                          productTrackAdult: null,
                        }
                      : {
                          packageId: pkg.id,
                          productIdJunior: null,
                          productTrackJunior: null,
                        },
                  );
                }}
              />
            ))}
            <div className="flex items-center gap-3 py-2">
              <div className="h-px flex-1 bg-white/10" />
              <span className="text-xs uppercase tracking-wider text-white/30">
                or pick a single race
              </span>
              <div className="h-px flex-1 bg-white/10" />
            </div>
          </div>
        )}

        <div className="space-y-6">
          {groupByTier(sorted).map(([tier, tierProducts]) => (
            <div key={tier}>
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TIER_COLOR[tier].badge}`}
                >
                  {TIER_LABEL[tier]}
                </span>
                <div className="h-px flex-1 bg-white/10" />
              </div>
              <div className="grid gap-3">
                {tierProducts.map((product) => (
                  <ProductCard
                    key={product.productId}
                    product={product}
                    isSelected={selectedProductId === product.productId}
                    selectedTrack={selectedTrack}
                    onSelect={() => handleCardClick(product)}
                    racerType={racerType}
                    racerCount={racerCount}
                  />
                ))}
              </div>
            </div>
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
  selectedTrack,
  onSelect,
  racerType,
  racerCount,
}: {
  product: RaceProduct;
  isSelected: boolean;
  selectedTrack: string | null;
  onSelect: () => void;
  racerType: RacerType;
  racerCount: number;
}) {
  const c = TIER_COLOR[product.tier];
  const tierLabel = TIER_LABEL[product.tier];
  const tierDesc = TIER_DESCRIPTIONS[product.tier];
  const isPack = product.packType === "combo";
  const isMulti = isMultiTrack(product);
  const racers = Math.max(1, racerCount);

  const isSinglePerPersonRace = !isPack && product.price > 0;
  const showNewBreakdown = isSinglePerPersonRace && racerType === "new";
  const licensePerRacer = showNewBreakdown ? LICENSE_PRICE : 0;
  const perRacerTotal = product.price + licensePerRacer;
  const groupTotal = perRacerTotal * racers;

  // Display track: for multi-track packs after a choice has been made,
  // show the chosen track inline (matches v1 ProductPicker:283 behavior).
  const displayTrack = isMulti && isSelected ? selectedTrack : product.track;

  const trackAccent: Record<string, string> = {
    Red: "#E53935",
    Blue: "#2196F3",
    Mega: "#A855F7",
  };
  const leftBorderColor = displayTrack ? trackAccent[displayTrack] : undefined;

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
      style={leftBorderColor ? { borderLeftWidth: 4, borderLeftColor: leftBorderColor } : undefined}
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
          {displayTrack && TRACK_BADGE[displayTrack] && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-bold ${TRACK_BADGE[displayTrack].bg} ${TRACK_BADGE[displayTrack].text}`}
            >
              {displayTrack} Track
            </span>
          )}
          {/* Combined single race — both tracks offered; the heat grid shows
              both and the customer picks any time on either (like Ultimate). */}
          {isMulti &&
            !isPack &&
            Object.keys(product.trackProducts ?? {}).map(
              (t) =>
                TRACK_BADGE[t] && (
                  <span
                    key={t}
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${TRACK_BADGE[t].bg} ${TRACK_BADGE[t].text}`}
                  >
                    {t}
                  </span>
                ),
            )}
        </div>
        {showNewBreakdown ? (
          <span className={`${c.text} shrink-0 text-base font-bold`}>${groupTotal.toFixed(2)}</span>
        ) : product.price > 0 ? (
          <span className={`${c.text} shrink-0 text-sm font-bold whitespace-nowrap`}>
            ${product.price.toFixed(2)}
            {!isPack && <span className="text-xs text-white/40"> / racer</span>}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs leading-relaxed text-white/40">{tierDesc}</p>

      {showNewBreakdown && (
        <div className="mt-3 space-y-1 text-xs">
          <div className="flex items-baseline justify-between gap-2 text-white/70">
            <span>
              <span className="text-emerald-400">✓</span> {product.name}
              {racers > 1 && <span className="text-white/40"> × {racers}</span>}
            </span>
            <span className="text-white/60">${(product.price * racers).toFixed(2)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2 text-white/70">
            <span>
              <span className="text-emerald-400">✓</span> Racing License
              {racers > 1 && <span className="text-white/40"> × {racers}</span>}
            </span>
            <span className="text-white/60">${(licensePerRacer * racers).toFixed(2)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-white/10 pt-1.5">
            <span className="text-[11px] font-bold tracking-wider text-white/80 uppercase">
              Total
            </span>
            <span className={`${c.text} font-bold`}>${groupTotal.toFixed(2)}</span>
          </div>
        </div>
      )}

      {!showNewBreakdown && !isPack && racers > 1 && (
        <div className="mt-2 text-xs text-white/50">
          ${product.price.toFixed(2)} × {racers} racers = ${(product.price * racers).toFixed(2)}{" "}
          total
        </div>
      )}

      {isPack && product.price > 0 && (
        <p className="mt-1 text-xs text-amber-400/70">
          ${(product.price / (product.raceCount ?? 1)).toFixed(2)}/race — Race more, save more
        </p>
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
    if (item.packageId) return true;
    if (item.productIdAdult) return true;
    // Already added races via "Add another" (which clears the product)? Continue.
    const adultIds = new Set(
      session.party.filter((m) => (m.category ?? "adult") === "adult").map((m) => m.id),
    );
    if (item.heats.some((h) => h.heatId && h.assignedTo && adultIds.has(h.assignedTo))) return true;
    return { reason: "Pick an adult race to continue." };
  },
};

export const RaceProductStepJunior: StepDef<RaceItem> = {
  id: "race-product-junior",
  title: "Junior Race",
  Component: makeProductStepComponent("junior"),
  isVisible: (_item, session) => hasCategory(session, "junior"),
  canAdvance: (item, session) => {
    if (!hasCategory(session, "junior")) return true;
    if (item.packageId) return true;
    if (item.productIdJunior) return true;
    // Already added races via "Add another" (which clears the product)? Continue.
    const juniorIds = new Set(
      session.party.filter((m) => m.category === "junior").map((m) => m.id),
    );
    if (item.heats.some((h) => h.heatId && h.assignedTo && juniorIds.has(h.assignedTo)))
      return true;
    return { reason: "Pick a junior race to continue." };
  },
};
