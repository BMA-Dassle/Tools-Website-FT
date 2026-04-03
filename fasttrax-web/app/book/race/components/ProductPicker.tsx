"use client";

import Image from "next/image";
import type { ClassifiedProduct, RacerType } from "../data";
import { TIER_COLOR, TIER_LABELS, groupByTrack } from "../data";

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

      {/* Track descriptions — clickable to select track */}
      {products.length > 0 && (() => {
        const redProduct = products.find(p => p.track === "Red");
        const blueProduct = products.find(p => p.track === "Blue");
        const isRedSelected = selected?.track === "Red";
        const isBlueSelected = selected?.track === "Blue";

        return (
        <div className="space-y-4 max-w-lg mx-auto">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => redProduct && onSelect(redProduct)}
              disabled={!redProduct}
              className={`relative rounded-xl overflow-hidden border-2 aspect-[3/4] transition-all duration-200 text-left ${
                isRedSelected
                  ? "border-red-500 ring-2 ring-red-500/30 ring-offset-2 ring-offset-[#010A20]"
                  : "border-red-500/30 hover:border-red-500/60"
              } ${!redProduct ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
            >
              <Image
                src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/red-track-1Fsl8rQ5rVIHi6hXkkvUraGEqr4WM2.jpg"
                alt="Red Track"
                fill
                className="object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-red-900/90 via-red-900/40 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-3 text-center">
                <h3 className="font-display text-white text-lg uppercase tracking-wider mb-1">Red Track</h3>
                <p className="text-white/70 text-[11px] leading-snug">
                  Sharp turns and relentless hairpins — a technical gauntlet for drivers who thrive on control.
                </p>
              </div>
              {isRedSelected && (
                <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-red-500 flex items-center justify-center text-white text-xs font-bold">✓</div>
              )}
            </button>
            <button
              onClick={() => blueProduct && onSelect(blueProduct)}
              disabled={!blueProduct}
              className={`relative rounded-xl overflow-hidden border-2 aspect-[3/4] transition-all duration-200 text-left ${
                isBlueSelected
                  ? "border-blue-500 ring-2 ring-blue-500/30 ring-offset-2 ring-offset-[#010A20]"
                  : "border-blue-500/30 hover:border-blue-500/60"
              } ${!blueProduct ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
            >
              <Image
                src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg"
                alt="Blue Track"
                fill
                className="object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-blue-900/90 via-blue-900/40 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-3 text-center">
                <h3 className="font-display text-white text-lg uppercase tracking-wider mb-1">Blue Track</h3>
                <p className="text-white/70 text-[11px] leading-snug">
                  Smooth banks, sweeping turns, and high-speed straights — the perfect mix of speed and precision.
                </p>
              </div>
              {isBlueSelected && (
                <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold">✓</div>
              )}
            </button>
          </div>
        </div>
        );
      })()}

      {products.length === 0 && (
        <div className="text-center py-8">
          <p className="text-white/40 text-sm">No races available for this date and party. Try a different date.</p>
        </div>
      )}

      {/* Adult races */}
      {hasAdultSection && (
        <Section title={juniors > 0 ? "Adult Races" : undefined}>
          {adultGroups.map(([key, items]) => (
            <ProductGroup key={key} items={items} selected={selected} onSelect={onSelect} />
          ))}
        </Section>
      )}

      {/* Junior races */}
      {hasJuniorSection && (
        <Section title={adults > 0 ? "Junior Races" : undefined}>
          {juniorGroups.map(([key, items]) => (
            <ProductGroup key={key} items={items} selected={selected} onSelect={onSelect} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      {title && (
        <p className="text-xs font-bold uppercase tracking-widest text-white/30 text-center">{title}</p>
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
          <span className={`ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full ${c.badge}`}>
            {tierLabel}
          </span>
          {representative.packType !== "none" && (
            <span className="ml-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
              {representative.raceCount}-Race Pack
            </span>
          )}
        </div>
        <span className={`${c.text} font-bold text-sm`}>${representative.price.toFixed(2)}</span>
      </div>

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
        <p className="text-amber-400/60 text-[10px] mt-2">{representative.raw.message}</p>
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
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.badge}`}>
            {tierLabel}
          </span>
          {isPack && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
              {product.raceCount}-Race Pack
            </span>
          )}
        </div>
        <span className={`${c.text} font-bold text-sm shrink-0`}>${product.price.toFixed(2)}</span>
      </div>

      {product.track && (
        <p className="text-white/30 text-xs">{product.track} Track</p>
      )}

      {isPack && (
        <p className="text-amber-400/70 text-xs mt-1">
          ${(product.price / product.raceCount).toFixed(2)}/race — Race more, save more
        </p>
      )}

      {product.raw.message && !isPack && (
        <p className="text-amber-400/60 text-[10px] mt-1.5">{product.raw.message}</p>
      )}
    </button>
  );
}
