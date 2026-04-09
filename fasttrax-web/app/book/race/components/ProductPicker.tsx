"use client";

import Image from "next/image";
import type { ClassifiedProduct, RacerType } from "../data";
import { TIER_COLOR, TIER_LABELS, TIER_DESCRIPTIONS, groupByTrack } from "../data";

interface ProductPickerProps {
  products: ClassifiedProduct[];
  racerType: RacerType;
  adults: number;
  juniors: number;
  selected: ClassifiedProduct | null;
  onSelect: (product: ClassifiedProduct) => void;
}

export default function ProductPicker({ products, racerType, adults, juniors, selected, onSelect }: ProductPickerProps) {
  const grouped = groupByTrack(products);

  // Separate adult and junior product groups
  const adultGroups: [string, ClassifiedProduct[]][] = [];
  const juniorGroups: [string, ClassifiedProduct[]][] = [];
  for (const [key, items] of grouped) {
    if (items[0].category === "junior") juniorGroups.push([key, items]);
    else adultGroups.push([key, items]);
  }

  const hasAdultSection = adults > 0 && adultGroups.length > 0;
  const hasJuniorSection = juniors > 0 && juniorGroups.length > 0;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">
          {racerType === "new" ? "Pick Your Starter Race" : "Choose Your Race"}
        </h2>
        <p className="text-white/40 text-sm max-w-md mx-auto">
          {racerType === "new"
            ? "All first-time racers start here. Pick the race that fits your group."
            : "Select from races you've qualified for."}
        </p>
      </div>

      {/* Track info — visual only, adapts to available tracks */}
      {products.length > 0 && (() => {
        const hasMega = products.some(p => p.track === "Mega");
        const hasRedBlue = products.some(p => p.track === "Red") || products.some(p => p.track === "Blue");

        if (hasMega && !hasRedBlue) {
          // Mega Track Day — both tracks combined
          return (
            <div className="max-w-lg mx-auto space-y-3">
              <div className="relative rounded-xl overflow-hidden border border-purple-500/30 aspect-[2/1]">
                <Image
                  src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/red-track-1Fsl8rQ5rVIHi6hXkkvUraGEqr4WM2.jpg"
                  alt="Mega Track"
                  fill
                  className="object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-purple-900/90 via-purple-900/40 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-3 text-center">
                  <h3 className="font-display text-white text-lg uppercase tracking-wider">Mega Track Day</h3>
                  <p className="text-white/60 text-xs leading-snug mt-0.5">
                    Both tracks combined into one epic circuit
                  </p>
                </div>
              </div>
            </div>
          );
        }

        // Standard day — Red & Blue tracks
        return (
          <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
            <div className="relative rounded-xl overflow-hidden border border-red-500/20 aspect-[4/3]">
              <Image
                src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/red-track-1Fsl8rQ5rVIHi6hXkkvUraGEqr4WM2.jpg"
                alt="Red Track"
                fill
                className="object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-red-900/90 via-red-900/30 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-2.5 text-center">
                <h3 className="font-display text-white text-base uppercase tracking-wider">Red Track</h3>
                <p className="text-white/60 text-xs leading-snug mt-0.5">
                  Technical hairpins &amp; sharp turns
                </p>
              </div>
            </div>
            <div className="relative rounded-xl overflow-hidden border border-blue-500/20 aspect-[4/3]">
              <Image
                src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg"
                alt="Blue Track"
                fill
                className="object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-blue-900/90 via-blue-900/30 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-2.5 text-center">
                <h3 className="font-display text-white text-base uppercase tracking-wider">Blue Track</h3>
                <p className="text-white/60 text-xs leading-snug mt-0.5">
                  High-speed banks &amp; sweeping turns
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* New racer license notice */}
      {racerType === "new" && products.length > 0 && (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 max-w-lg mx-auto">
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-8 h-8 rounded-full bg-blue-500/15 flex items-center justify-center mt-0.5">
              <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 9h3.75M15 12h3.75M15 15h3.75M4.5 19.5h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5zm6-10.125a1.875 1.875 0 11-3.75 0 1.875 1.875 0 013.75 0zm1.294 6.336a6.721 6.721 0 01-3.17.789 6.721 6.721 0 01-3.168-.789 3.376 3.376 0 016.338 0z" />
              </svg>
            </div>
            <div>
              <p className="text-blue-400 font-bold text-sm">FastTrax Racing License — $4.99/person</p>
              <p className="text-white/40 text-xs mt-1 leading-relaxed">
                Required for all first-time racers. Valid for one year and includes use of head sock, helmet, and access to the FastTrax app for race scheduling.
              </p>
              <p className="text-white/25 text-xs mt-1.5">Automatically added to your order at checkout.</p>
            </div>
          </div>
        </div>
      )}

      {products.length === 0 && (
        <div className="text-center py-8">
          <p className="text-white/40 text-sm">No races available for this date and party. Try a different date.</p>
        </div>
      )}

      {/* Adult races */}
      {hasAdultSection && (
        <Section
          title={juniors > 0 ? "Adult Races" : undefined}
          subtitle={juniors > 0 ? `Pick a race for your ${adults} adult racer${adults !== 1 ? "s" : ""}` : undefined}
        >
          {adultGroups.map(([key, items]) => (
            <ProductGroup key={key} items={items} selected={selected} onSelect={onSelect} />
          ))}
        </Section>
      )}

      {/* Junior races */}
      {hasJuniorSection && (
        <Section
          title={adults > 0 ? "Junior Races" : undefined}
          subtitle={adults > 0 ? `Pick a race for your ${juniors} junior racer${juniors !== 1 ? "s" : ""}` : undefined}
        >
          {juniorGroups.map(([key, items]) => (
            <ProductGroup key={key} items={items} selected={selected} onSelect={onSelect} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      {(title || subtitle) && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2.5 text-center">
          {title && <p className="text-amber-400 text-xs font-bold uppercase tracking-widest">{title}</p>}
          {subtitle && <p className="text-white/50 text-xs mt-0.5">{subtitle}</p>}
        </div>
      )}
      <div className="grid gap-3">
        {children}
      </div>
    </div>
  );
}

function ProductGroup({ items, selected, onSelect }: {
  items: ClassifiedProduct[];
  selected: ClassifiedProduct | null;
  onSelect: (p: ClassifiedProduct) => void;
}) {
  const hasMultipleTracks = items.length > 1 && items.some(i => i.track === "Red") && items.some(i => i.track === "Blue");
  const representative = items[0];
  const c = TIER_COLOR[representative.tier];
  const tierLabel = TIER_LABELS[representative.tier];

  // Single product or Mega — just show one card
  if (!hasMultipleTracks) {
    const product = items[0];
    const isSelected = selected?.productId === product.productId;
    return (
      <ProductCard product={product} isSelected={isSelected} onSelect={onSelect} />
    );
  }

  // Multiple tracks — show a grouped card with track toggle
  const isAnySelected = items.some(i => selected?.productId === i.productId);
  const selectedTrackProduct = items.find(i => selected?.productId === i.productId);

  return (
    <div className={`rounded-xl border p-4 transition-all duration-200 ${
      isAnySelected
        ? `${c.border} ${c.bg} ring-2 ring-offset-2 ring-offset-[#010A20]`
        : "border-white/10 bg-white/5"
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <span className="font-bold text-white text-sm">
            {representative.name.replace(/\s+(Red|Blue)$/i, "").trim()}
          </span>
          <span className={`ml-2 text-xs font-bold px-2 py-0.5 rounded-full ${c.badge}`}>
            {tierLabel}
          </span>
          {representative.packType !== "none" && (
            <span className="ml-1 text-xs font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
              {representative.raceCount}-Race Pack
            </span>
          )}
        </div>
        {representative.price > 0 && (
          <span className={`${c.text} font-bold text-sm`}>${representative.price.toFixed(2)}</span>
        )}
      </div>
      <p className="text-white/40 text-xs mb-3 leading-relaxed">{TIER_DESCRIPTIONS[representative.tier]}</p>

      {/* Track selection */}
      <p className="text-white/40 text-xs mb-2">Which track?</p>
      <div className="flex gap-2">
        {items.map(item => {
          const isThis = selected?.productId === item.productId;
          return (
            <button
              key={item.productId}
              onClick={() => onSelect(item)}
              className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-all duration-200 ${
                item.track === "Red"
                  ? isThis
                    ? "bg-red-500/25 text-red-400 border-2 border-red-500 ring-1 ring-red-500/30"
                    : "bg-red-500/10 text-red-400/70 border border-red-500/30 hover:bg-red-500/20 hover:text-red-400"
                  : isThis
                    ? "bg-blue-500/25 text-blue-400 border-2 border-blue-500 ring-1 ring-blue-500/30"
                    : "bg-blue-500/10 text-blue-400/70 border border-blue-500/30 hover:bg-blue-500/20 hover:text-blue-400"
              }`}
            >
              {item.track} Track
            </button>
          );
        })}
      </div>

      {representative.raw.message && (
        <p className="text-amber-400/60 text-xs mt-2">{representative.raw.message}</p>
      )}
    </div>
  );
}

function ProductCard({ product, isSelected, onSelect }: {
  product: ClassifiedProduct;
  isSelected: boolean;
  onSelect: (p: ClassifiedProduct) => void;
}) {
  const c = TIER_COLOR[product.tier];
  const tierLabel = TIER_LABELS[product.tier];
  const isPack = product.packType !== "none";

  return (
    <button
      onClick={() => onSelect(product)}
      className={`text-left rounded-xl border p-4 transition-all duration-200 ${
        isSelected
          ? `${c.border} ${c.bg} ring-2 ring-offset-2 ring-offset-[#010A20]`
          : isPack
            ? "border-amber-500/20 bg-amber-500/5 hover:border-amber-500/40 hover:bg-amber-500/10"
            : "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/8"
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-white text-sm">{product.name}</span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${c.badge}`}>
            {tierLabel}
          </span>
          {isPack && (
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
              {product.raceCount}-Race Pack
            </span>
          )}
        </div>
        {product.price > 0 && (
          <span className={`${c.text} font-bold text-sm shrink-0`}>${product.price.toFixed(2)}</span>
        )}
      </div>

      <p className="text-white/40 text-xs mt-1 leading-relaxed">{TIER_DESCRIPTIONS[product.tier]}</p>

      {product.track && (
        <p className="text-white/30 text-xs mt-1">{product.track} Track</p>
      )}

      {isPack && product.price > 0 && (
        <p className="text-amber-400/70 text-xs mt-1">
          ${(product.price / product.raceCount).toFixed(2)}/race — Race more, save more
        </p>
      )}

      {product.raw.message && !isPack && (
        <p className="text-amber-400/60 text-xs mt-1.5">{product.raw.message}</p>
      )}
    </button>
  );
}
