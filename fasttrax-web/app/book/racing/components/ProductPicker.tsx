"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import type { ClassifiedProduct, RacerType, RaceTier } from "../data";
import { TIER_COLOR, TIER_LABELS, groupByTrack } from "../data";
import { modalBackdropProps } from "@/lib/a11y";

// ── Track info shown in the "Pick your track" modal ─────────────────────────
// Pulled from the live /racing page copy so the picker stays consistent with
// the marketing description of each track.
const TRACK_INFO: Record<string, {
  title: string;
  stat: string;
  tagline: string;
  image: string;
  accent: string; // Tailwind color class stem (e.g. "red" / "blue")
}> = {
  Red: {
    title: "Red Track",
    stat: "1,013 ft",
    tagline: "High-speed & counter-clockwise — long straights, quick finishes.",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/red-track-1Fsl8rQ5rVIHi6hXkkvUraGEqr4WM2.jpg",
    accent: "red",
  },
  Blue: {
    title: "Blue Track",
    stat: "1,095 ft",
    tagline: "Technical & clockwise — more turns, more strategy.",
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg",
    accent: "blue",
  },
};

/** Ordering for tier groups in the picker. */
const TIER_ORDER: Record<RaceTier, number> = { starter: 0, intermediate: 1, pro: 2 };

/**
 * Sort picker groups so each tier's single race sits directly above its
 * 3-pack variant: Starter → Intermediate → Intermediate 3-Pack → Pro →
 * Pro 3-Pack. `groupByTrack` keys include packType so single + pack land
 * in distinct groups; without this sort they land in BMI-response order,
 * which pushes all packs to the bottom and separates them from the
 * matching tier single.
 */
function sortGroups(groups: [string, ClassifiedProduct[]][]) {
  return [...groups].sort((a, b) => {
    const ta = TIER_ORDER[a[1][0].tier];
    const tb = TIER_ORDER[b[1][0].tier];
    if (ta !== tb) return ta - tb;
    // Within a tier: single race (raceCount=1) before pack (raceCount=3).
    return a[1][0].raceCount - b[1][0].raceCount;
  });
}

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

  // Separate adult and junior product groups, then sort each so each
  // tier's single race sits directly above its matching 3-pack.
  const adultGroupsRaw: [string, ClassifiedProduct[]][] = [];
  const juniorGroupsRaw: [string, ClassifiedProduct[]][] = [];
  for (const [key, items] of grouped) {
    if (items[0].category === "junior") juniorGroupsRaw.push([key, items]);
    else adultGroupsRaw.push([key, items]);
  }
  const adultGroups = sortGroups(adultGroupsRaw);
  const juniorGroups = sortGroups(juniorGroupsRaw);

  const hasAdultSection = adults > 0 && adultGroups.length > 0;
  const hasJuniorSection = juniors > 0 && juniorGroups.length > 0;

  /**
   * When a multi-track product card is clicked, we stash its items here
   * and render the TrackPickerModal. This keeps single-track + pack cards
   * looking consistent in the grid (no inline Red/Blue buttons) and
   * promotes track choice to a first-class step with stats + imagery.
   */
  const [trackModalItems, setTrackModalItems] = useState<ClassifiedProduct[] | null>(null);

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

      {products.length === 0 && (
        <div className="text-center py-8">
          <p className="text-white/40 text-sm">No races available for this date and party. Try a different date.</p>
        </div>
      )}

      {/* Adult races */}
      {hasAdultSection && (
        <Section title={juniors > 0 ? "Adult Races" : undefined}>
          {adultGroups.map(([key, items]) => (
            <ProductGroup
              key={key}
              items={items}
              selected={selected}
              onSelect={onSelect}
              onOpenTrackModal={setTrackModalItems}
            />
          ))}
        </Section>
      )}

      {/* Junior races */}
      {hasJuniorSection && (
        <Section title={adults > 0 ? "Junior Races" : undefined}>
          {juniorGroups.map(([key, items]) => (
            <ProductGroup
              key={key}
              items={items}
              selected={selected}
              onSelect={onSelect}
              onOpenTrackModal={setTrackModalItems}
            />
          ))}
        </Section>
      )}

      {trackModalItems && (
        <TrackPickerModal
          items={trackModalItems}
          onSelect={(p) => { onSelect(p); setTrackModalItems(null); }}
          onClose={() => setTrackModalItems(null)}
        />
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

function ProductGroup({ items, selected, onSelect, onOpenTrackModal }: {
  items: ClassifiedProduct[];
  selected: ClassifiedProduct | null;
  onSelect: (p: ClassifiedProduct) => void;
  onOpenTrackModal: (items: ClassifiedProduct[]) => void;
}) {
  const hasMultipleTracks = items.length > 1 && items.some(i => i.track === "Red") && items.some(i => i.track === "Blue");

  // Single product (Mega / single-track / 3-pack) → one ProductCard.
  if (!hasMultipleTracks) {
    const product = items[0];
    const isSelected = selected?.productId === product.productId;
    return <ProductCard product={product} isSelected={isSelected} onSelect={onSelect} />;
  }

  // Multi-track → render ONE merged card (same visual as the other
  // products) and hand track selection off to the modal. Picks up a
  // "Track: X" hint on the card when a track is already selected in
  // this group, so returning to the picker stays legible.
  const selectedTrackProduct = items.find(i => selected?.productId === i.productId);
  const merged: ClassifiedProduct = {
    ...items[0],
    name: items[0].name.replace(/\s+(Red|Blue)$/i, "").trim(),
    track: selectedTrackProduct?.track ?? null,
  };
  const isSelected = !!selectedTrackProduct;
  return (
    <ProductCard
      product={merged}
      isSelected={isSelected}
      onSelect={() => onOpenTrackModal(items)}
    />
  );
}

// ── Track picker modal — shown after the guest clicks a multi-track product ──
function TrackPickerModal({ items, onSelect, onClose }: {
  items: ClassifiedProduct[];
  onSelect: (p: ClassifiedProduct) => void;
  onClose: () => void;
}) {
  const rep = items[0];
  const tierColor = TIER_COLOR[rep.tier];
  const tierLabel = TIER_LABELS[rep.tier];
  const baseName = rep.name.replace(/\s+(Red|Blue)$/i, "").trim();

  // Lock the body scroll while the modal is open so mobile devices
  // don't forward scroll events to the page behind. Restore on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Order the two options so Blue always renders first — matches the
  // existing marketing copy on /racing.
  const ordered = [...items].sort((a, b) => {
    if (a.track === "Blue") return -1;
    if (b.track === "Blue") return 1;
    return 0;
  });

  return (
    <div
      // Fixed, non-scrolling backdrop — the inner card owns its scroll.
      // dvh (dynamic viewport height) respects mobile safe areas.
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm"
      style={{ height: "100dvh" }}
      {...modalBackdropProps(onClose)}
    >
      <div
        // Cap at viewport height minus the backdrop padding, and let
        // the card scroll internally if content is taller.
        className="relative w-full max-w-2xl rounded-2xl overflow-y-auto overscroll-contain flex flex-col"
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
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
          style={{ fontSize: "20px", lineHeight: 1 }}
        >
          &times;
        </button>
        <div className="p-4 sm:p-7">
          <div className="mb-4 sm:mb-5 pr-10">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h3 className="font-display text-white text-lg sm:text-xl uppercase tracking-wider">{baseName}</h3>
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${tierColor.badge}`}>
                {tierLabel}
              </span>
            </div>
            <p className={`${tierColor.text} font-bold text-sm`}>${rep.price.toFixed(2)}</p>
          </div>

          <p className="text-white/60 text-sm mb-3 uppercase tracking-wider font-semibold text-[11px]">Pick your track</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ordered.map(item => {
              const info = item.track ? TRACK_INFO[item.track] : null;
              if (!info) return null;
              const ringClass = info.accent === "red"
                ? "border-red-500/50 hover:border-red-500 hover:ring-red-500/30"
                : "border-blue-500/50 hover:border-blue-500 hover:ring-blue-500/30";
              const titleClass = info.accent === "red" ? "text-red-300" : "text-blue-300";
              return (
                <button
                  key={item.productId}
                  type="button"
                  onClick={() => onSelect(item)}
                  className={`group relative overflow-hidden rounded-xl text-left border transition-all duration-200 hover:scale-[1.02] hover:ring-2 cursor-pointer ${ringClass}`}
                >
                  {/* Shorter aspect on mobile so both cards fit in one
                      viewport height without internal scroll on phones. */}
                  <div className="relative aspect-[21/9] sm:aspect-[4/3]">
                    <Image
                      src={info.image}
                      alt={info.title}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-500"
                      sizes="(max-width: 640px) 100vw, 50vw"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                  </div>
                  <div className="p-3">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <h4 className={`font-display text-base uppercase tracking-wide ${titleClass}`}>
                        {info.title}
                      </h4>
                      <span className="text-white/50 text-xs font-mono">{info.stat}</span>
                    </div>
                    <p className="text-white/70 text-xs leading-snug">{info.tagline}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {rep.raw.message && (
            <p className="text-amber-400/80 text-xs mt-4 text-center">{rep.raw.message}</p>
          )}
        </div>
      </div>
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
        <p className="text-amber-400/60 text-xs mt-1.5">{product.raw.message}</p>
      )}
    </button>
  );
}
