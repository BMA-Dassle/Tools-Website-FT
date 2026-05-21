"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
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
 * v1 parity: full port of `apps/web/app/book/race/components/ProductPicker.tsx`.
 * Mirrors:
 *   - Title differs by racerType: "Pick Your Starter Race" (new) vs
 *     "Choose Your Race" (existing)
 *   - Tier descriptions render under name + tier label
 *   - Multi-track packs (parent has `trackProducts`) collapse to a single
 *     merged card; click opens TrackPickerModal with Red + Blue cards
 *     (track image + accent + tagline)
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

// Track image + copy used inside TrackPickerModal — verbatim port from v1.
const TRACK_INFO: Record<
  string,
  {
    title: string;
    stat: string;
    tagline: string;
    image: string;
    accent: "red" | "blue";
  }
> = {
  Red: {
    title: "Red Track",
    stat: "1,095 ft",
    tagline: "Technical & clockwise — more turns, more strategy.",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/red-track-1Fsl8rQ5rVIHi6hXkkvUraGEqr4WM2.jpg",
    accent: "red",
  },
  Blue: {
    title: "Blue Track",
    stat: "1,013 ft",
    tagline: "High-speed & counter-clockwise — long straights, quick finishes.",
    image:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg",
    accent: "blue",
  },
};

function racersOfCategory(
  party: { category?: Category; isNewRacer: boolean }[],
  category: Category,
): { category?: Category; isNewRacer: boolean }[] {
  return party.filter((m) => (m.category ?? "adult") === category);
}

function isMultiTrack(product: RaceProduct): boolean {
  return !!product.trackProducts && Object.keys(product.trackProducts).length > 1;
}

function makeProductStepComponent(category: Category): StepDef<RaceItem>["Component"] {
  const Component: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
    const [trackModalProduct, setTrackModalProduct] = useState<RaceProduct | null>(null);

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

    const sorted = [...products].sort((a, b) => {
      const ta = TIER_ORDER[a.tier];
      const tb = TIER_ORDER[b.tier];
      if (ta !== tb) return ta - tb;
      return (a.raceCount ?? 1) - (b.raceCount ?? 1);
    });

    const selectedProductId = category === "adult" ? item.productIdAdult : item.productIdJunior;
    const selectedTrack = category === "adult" ? item.productTrackAdult : item.productTrackJunior;

    const setProductWithTrack = (productId: string, track: string | null) =>
      onChange(
        category === "adult"
          ? { productIdAdult: productId, productTrackAdult: track }
          : { productIdJunior: productId, productTrackJunior: track },
      );

    const handleCardClick = (product: RaceProduct) => {
      if (isMultiTrack(product)) {
        setTrackModalProduct(product);
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

    return (
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h3 className="font-display text-2xl tracking-widest text-white uppercase">
            {racerType === "new"
              ? category === "adult"
                ? "Pick Your Starter Race"
                : "Pick Your Junior Starter Race"
              : category === "adult"
                ? "Choose Your Race"
                : "Choose Your Junior Race"}
          </h3>
          <p className="mx-auto max-w-md text-sm text-white/40">
            {racerType === "new"
              ? `All first-time ${category}s start here. Pick the race that fits your group.`
              : `Select a race your ${category}s have qualified for.`}
          </p>
        </div>

        <div className="grid gap-3">
          {sorted.map((product) => (
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

        {trackModalProduct && (
          <TrackPickerModal
            product={trackModalProduct}
            onSelect={(track) => {
              setProductWithTrack(trackModalProduct.productId, track);
              setTrackModalProduct(null);
            }}
            onClose={() => setTrackModalProduct(null)}
          />
        )}
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

  const baseClasses = "text-left rounded-xl border p-4 transition-all duration-200 w-full";
  const selectedClasses = `${c.border} ${c.bg} ring-2 ring-offset-2 ring-offset-[#010A20]`;
  const packClasses =
    "border-amber-500/20 bg-amber-500/5 hover:border-amber-500/40 hover:bg-amber-500/10";
  const regularClasses = "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/8";

  // Display track: for multi-track packs after a choice has been made,
  // show the chosen track inline (matches v1 ProductPicker:283 behavior).
  const displayTrack = isMulti && isSelected ? selectedTrack : product.track;

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

      {displayTrack && <p className="mt-1 text-xs text-white/30">{displayTrack} Track</p>}

      {isMulti && !isSelected && (
        <p className="mt-1 text-xs text-amber-400/70">Choose Red or Blue track →</p>
      )}

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

/**
 * TrackPickerModal — opens when the customer picks a multi-track product
 * (e.g. Intermediate Weekday 3-Pack: Red + Blue). v1 port from
 * `ProductPicker.tsx:296-425`. Two side-by-side cards (Blue first to match
 * /racing marketing copy), each with track image + stat + tagline.
 */
function TrackPickerModal({
  product,
  onSelect,
  onClose,
}: {
  product: RaceProduct;
  onSelect: (track: string) => void;
  onClose: () => void;
}) {
  const c = TIER_COLOR[product.tier];
  const tierLabel = TIER_LABEL[product.tier];
  const tierDesc = TIER_DESCRIPTIONS[product.tier];
  const tracks = Object.keys(product.trackProducts ?? {});
  // Blue first per v1.
  const ordered = [...tracks].sort((a, b) => {
    if (a === "Blue") return -1;
    if (b === "Blue") return 1;
    return 0;
  });

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-4"
      style={{ height: "100dvh" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative flex w-full max-w-2xl flex-col overflow-y-auto overscroll-contain rounded-2xl"
        style={{
          backgroundColor: "#0a1128",
          border: "1.78px solid rgba(255,255,255,0.1)",
          maxHeight: "calc(100dvh - 1.5rem)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-3 right-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          style={{ fontSize: "20px", lineHeight: 1 }}
        >
          ×
        </button>
        <div className="p-4 sm:p-7">
          <div className="mb-4 pr-10 sm:mb-5">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h3 className="font-display text-lg tracking-wider text-white uppercase sm:text-xl">
                {product.name}
              </h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${c.badge}`}>
                {tierLabel}
              </span>
            </div>
            <p className={`${c.text} text-sm font-bold`}>${product.price.toFixed(2)}</p>
            <p className="mt-1 text-xs leading-relaxed text-white/50">{tierDesc}</p>
          </div>

          <p className="mb-3 text-[11px] font-semibold tracking-wider text-white/60 uppercase">
            Pick your track
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ordered.map((track) => {
              const info = TRACK_INFO[track];
              if (!info) return null;
              const ringClass =
                info.accent === "red"
                  ? "border-red-500/50 hover:border-red-500 hover:ring-red-500/30"
                  : "border-blue-500/50 hover:border-blue-500 hover:ring-blue-500/30";
              const titleClass = info.accent === "red" ? "text-red-300" : "text-blue-300";
              return (
                <button
                  key={track}
                  type="button"
                  onClick={() => onSelect(track)}
                  className={`group relative cursor-pointer overflow-hidden rounded-xl border text-left transition-all duration-200 hover:scale-[1.02] hover:ring-2 ${ringClass}`}
                >
                  <div className="relative aspect-[21/9] sm:aspect-[4/3]">
                    <Image
                      src={info.image}
                      alt={info.title}
                      fill
                      className="object-cover transition-transform duration-500 group-hover:scale-105"
                      sizes="(max-width: 640px) 100vw, 50vw"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                  </div>
                  <div className="p-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <h4
                        className={`font-display text-base tracking-wide uppercase ${titleClass}`}
                      >
                        {info.title}
                      </h4>
                      <span className="font-mono text-xs text-white/50">{info.stat}</span>
                    </div>
                    <p className="text-xs leading-snug text-white/70">{info.tagline}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
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
    if (!item.productIdAdult) return { reason: "Pick an adult race to continue." };
    // Multi-track packs require a track choice via TrackPickerModal.
    // (The reducer writes productIdAdult + productTrackAdult atomically
    // when the modal confirms, so this is belt-and-suspenders.)
    return true;
  },
};

export const RaceProductStepJunior: StepDef<RaceItem> = {
  id: "race-product-junior",
  title: "Junior Race",
  Component: makeProductStepComponent("junior"),
  isVisible: (_item, session) => hasCategory(session, "junior"),
  canAdvance: (item, session) => {
    if (!hasCategory(session, "junior")) return true;
    if (!item.productIdJunior) return { reason: "Pick a junior race to continue." };
    return true;
  },
};
