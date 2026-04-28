"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import type { ClassifiedProduct, RacerType, RaceTier } from "../data";
import { TIER_COLOR, TIER_LABELS, TIER_DESCRIPTIONS, groupByTrack } from "../data";
import type { PackageDefinition, PackageRaceComponent } from "@/lib/packages";
import { LICENSE_PRICE, POV_PRICE, POV_CHECKIN_PRICE, APPETIZER_RETAIL_VALUE } from "@/lib/packages";
import { modalBackdropProps } from "@/lib/a11y";

// ── Track info shown in the "Pick your track" modal ─────────────────────────
const TRACK_INFO: Record<string, {
  title: string;
  stat: string;
  tagline: string;
  image: string;
  accent: "red" | "blue";
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

/** Ordering for tier groups so Starter → Intermediate → Pro, with each
 *  tier's single race sitting directly above its matching 3-pack. */
const TIER_ORDER: Record<RaceTier, number> = { starter: 0, intermediate: 1, pro: 2 };
function sortGroups(groups: [string, ClassifiedProduct[]][]) {
  return [...groups].sort((a, b) => {
    const ta = TIER_ORDER[a[1][0].tier];
    const tb = TIER_ORDER[b[1][0].tier];
    if (ta !== tb) return ta - tb;
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
  /** Eligible packages for the current context (date / racer type /
   *  category). Pre-filtered by the parent so this component doesn't
   *  need to know about scheduling rules. Empty / undefined → no
   *  packages row renders. */
  packages?: PackageDefinition[];
  /** Total racer count (adults + juniors) — used for per-pack
   *  pricing display ("× N racers"). */
  racerCount?: number;
  /** Click handler for a package card. */
  onSelectPackage?: (pkg: PackageDefinition) => void;
  /** Booking date (YYYY-MM-DD) — passed down to PackageCard so it
   *  can fetch live prices from BMI's /availability endpoint. */
  date?: string | null;
}

export default function ProductPicker({ products, racerType, adults, juniors, selected, onSelect, packages = [], racerCount = 1, onSelectPackage, date = null }: ProductPickerProps) {
  /** When a multi-track product is clicked, stash its items here and
   *  render the TrackPickerModal. Keeps single-track + pack + multi-
   *  track cards visually consistent in the grid. */
  const [trackModalItems, setTrackModalItems] = useState<ClassifiedProduct[] | null>(null);
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

  const hasPackages = packages.length > 0 && onSelectPackage;
  return (
    <div className="space-y-6">
      {/* Single header for the whole step — packages and individual
          races flow under it. The old separate "Premium Packages"
          sub-header read as a competing title and made the page
          feel like two stacked steps. Now it's one Pick-Your-Race
          step with packages as the recommended option above plain
          races. */}
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

      {hasPackages && (
        <div className="grid gap-3">
          {packages.map((pkg) => (
            <PackageCard
              key={pkg.id}
              pkg={pkg}
              racerCount={racerCount}
              date={date}
              onSelect={onSelectPackage}
            />
          ))}
        </div>
      )}

      {hasPackages && (products.length > 0) && (
        <div className="flex items-center gap-3 text-white/30 text-[11px] uppercase tracking-widest">
          <div className="flex-1 h-px bg-white/10" />
          <span>or pick a single race</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>
      )}

      {products.length === 0 && (
        <div className="text-center py-8">
          <p className="text-white/40 text-sm">No races available for this date and party. Try a different date.</p>
        </div>
      )}

      {/* Adult races — Section titles removed; the page already shows
          a prominent "Adult Races / Pick a race for your N adult
          racers" context panel above ProductPicker, so duplicating it
          here was just visual clutter. */}
      {hasAdultSection && (
        <Section>
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
        <Section>
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

  // Multi-track → render ONE merged card (same visual as all other
  // products) and hand track selection off to the modal.
  const selectedTrackProduct = items.find(i => selected?.productId === i.productId);
  const merged: ClassifiedProduct = {
    ...items[0],
    name: items[0].name.replace(/\s+(Red|Blue)$/i, "").trim(),
    track: selectedTrackProduct?.track ?? null,
  };
  return (
    <ProductCard
      product={merged}
      isSelected={!!selectedTrackProduct}
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

  // Lock body scroll while the modal is open so mobile devices don't
  // forward scroll events to the page behind. Restore on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Blue first — matches the /racing marketing copy order.
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
        // Cap at viewport minus backdrop padding; internal scroll if
        // content is taller. overscroll-contain stops the scroll chain
        // from bubbling to the body when reaching either end.
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
            <p className="text-white/50 text-xs mt-1 leading-relaxed">
              {TIER_DESCRIPTIONS[rep.tier]}
            </p>
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
                  {/* Shorter aspect on mobile so both cards comfortably
                      fit within viewport height without card scroll. */}
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

/**
 * Live BMI price fetch — pulls per-component prices from
 * `/api/bmi?endpoint=availability` for the given date. Returns a
 * map keyed by component `ref`. Falls back to the registry's
 * static `price` per component when BMI is unreachable / slow.
 *
 * Used by PackageCard so the picker total auto-syncs with whatever
 * BMI's catalog says today — no risk of registry hardcodes drifting
 * out of sync with the actual sell prices.
 */
function usePackageLivePrices(pkg: PackageDefinition, date: string | null): {
  prices: Record<string, number>;
  loading: boolean;
} {
  const [prices, setPrices] = useState<Record<string, number>>(() => {
    // Seed with registry-static fallbacks so the card renders
    // immediately while the live fetch is in flight.
    const seed: Record<string, number> = {};
    for (const r of pkg.races) seed[r.ref] = r.price;
    return seed;
  });
  const [loading, setLoading] = useState(!!date && pkg.races.length > 0);

  useEffect(() => {
    let cancelled = false;
    if (!date || pkg.races.length === 0) {
      // Defer the state flip to the next microtask so we don't
      // trigger a cascading-render lint warning. Effect bodies that
      // synchronously setState are flagged by our ESLint config.
      Promise.resolve().then(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
    const dateOnly = date.split("T")[0];
    Promise.resolve().then(() => { if (!cancelled) setLoading(true); });

    async function loadOne(component: PackageRaceComponent): Promise<[string, number] | null> {
      try {
        const res = await fetch(`/api/bmi?endpoint=availability&date=${dateOnly}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ProductId: Number(component.productId),
            PageId: Number(component.pageId),
            Quantity: 1,
            OrderId: null,
            PersonId: null,
            DynamicLines: [],
          }),
        });
        if (!res.ok) return null;
        type AvailBlock = { prices?: { amount: number; depositKind: number }[] };
        type AvailProposalItem = { block?: AvailBlock };
        type AvailProposal = { blocks?: AvailProposalItem[] };
        const data = (await res.json()) as { proposals?: AvailProposal[] };
        const proposals = data?.proposals || [];
        for (const p of proposals) {
          for (const b of p.blocks || []) {
            const cash = b.block?.prices?.find((pr: { amount: number; depositKind: number }) => pr.depositKind === 0);
            if (cash?.amount) return [component.ref, cash.amount];
          }
        }
        return null;
      } catch {
        return null;
      }
    }

    Promise.all(pkg.races.map(loadOne)).then((results) => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const r of pkg.races) next[r.ref] = r.price; // baseline
      for (const r of results) if (r) next[r[0]] = r[1]; // overlay live
      setPrices(next);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [pkg, date]);

  return { prices, loading };
}

/** Package card — price-prominent layout with itemized included
 *  list, live BMI pricing, and a "you save" line. Each item shows
 *  per-racer × N math so the customer sees exactly what they're
 *  paying for. */
function PackageCard({ pkg, racerCount, date, onSelect }: {
  pkg: PackageDefinition;
  racerCount: number;
  date: string | null;
  onSelect: (pkg: PackageDefinition) => void;
}) {
  const { prices: livePrices, loading } = usePackageLivePrices(pkg, date);
  const racers = Math.max(1, racerCount);

  // Build line items with live BMI prices. Each line is per-racer
  // × N (heats are shared across racers, but license + POV scale
  // per-racer; appetizer is one per group).
  type Line = { key: string; label: string; perUnit: number | null; quantity: number; lineTotal: number; freeNote?: string };
  const lines: Line[] = [];
  for (const r of pkg.races) {
    const perUnit = livePrices[r.ref] ?? r.price;
    lines.push({
      key: r.ref,
      label: r.label,
      perUnit,
      quantity: racers,
      lineTotal: perUnit * racers,
    });
  }
  if (pkg.includesLicense) {
    lines.push({
      key: "license",
      label: "Racing License",
      perUnit: LICENSE_PRICE,
      quantity: racers,
      lineTotal: LICENSE_PRICE * racers,
    });
  }
  if (pkg.includesPov) {
    lines.push({
      key: "pov",
      label: "POV Race Video",
      perUnit: POV_PRICE,
      quantity: racers,
      lineTotal: POV_PRICE * racers,
    });
  }
  if (pkg.appetizerCode) {
    lines.push({
      key: "appetizer",
      label: "Free Appetizer at Nemo's",
      perUnit: 0,
      quantity: 1,
      lineTotal: 0,
      freeNote: "1 per group · race day only",
    });
  }

  const total = lines.reduce((acc, l) => acc + l.lineTotal, 0);

  // "You save" math — what the contents would cost piecemeal at
  // retail (POV at check-in price, appetizer at menu retail).
  const retail = (() => {
    let r = 0;
    for (const l of pkg.races) r += (livePrices[l.ref] ?? l.price) * racers;
    if (pkg.includesLicense) r += LICENSE_PRICE * racers;
    if (pkg.includesPov) r += POV_CHECKIN_PRICE * racers;
    if (pkg.appetizerCode) r += APPETIZER_RETAIL_VALUE;
    return r;
  })();
  const youSave = Math.max(0, retail - total);

  return (
    <button
      type="button"
      onClick={() => onSelect(pkg)}
      className="text-left rounded-xl border-2 border-amber-500/40 bg-gradient-to-br from-amber-500/10 to-amber-500/5 p-5 transition-all duration-200 hover:border-amber-500/60 hover:from-amber-500/15 hover:to-amber-500/8"
    >
      {/* Header — name + total. Total leads so the customer sees
          what they're paying for the bundle up front. */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-amber-400 text-[11px] font-bold uppercase tracking-widest">
            {pkg.name}
          </span>
          {racers > 1 && (
            <span className="text-white/30 text-xs">{racers} racers</span>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-amber-300 font-bold text-lg leading-none">
            ${total.toFixed(2)}
          </p>
          {loading && (
            <p className="text-white/30 text-[10px] mt-1">updating…</p>
          )}
        </div>
      </div>

      <p className="text-white/60 text-xs leading-relaxed mb-3">{pkg.longDescription}</p>

      {/* Itemized "What's included" — per-racer × N + line totals */}
      <ul className="space-y-1 text-xs text-white/75 mb-2">
        {lines.map((l) => (
          <li key={l.key} className="flex items-baseline justify-between gap-2">
            <span>
              <span className="text-emerald-400">✓</span> {l.label}
              {l.quantity > 1 && <span className="text-white/40"> × {l.quantity}</span>}
              {l.freeNote && <span className="text-white/40"> ({l.freeNote})</span>}
            </span>
            <span className={l.lineTotal === 0 ? "text-emerald-300 font-semibold" : "text-white/60"}>
              {l.lineTotal === 0 ? "FREE" : `$${l.lineTotal.toFixed(2)}`}
            </span>
          </li>
        ))}
      </ul>

      {/* Total + savings line — savings only shown when meaningful. */}
      <div className="flex items-baseline justify-between text-sm pt-3 border-t border-amber-500/20">
        <span className="text-amber-400 font-bold uppercase tracking-wider text-xs">
          {pkg.name} total
        </span>
        <span className="text-white font-bold">${total.toFixed(2)}</span>
      </div>
      {youSave > 0 && (
        <div className="flex items-baseline justify-between text-xs mt-1.5">
          <span className="text-amber-400 font-bold">💰 You save ${youSave.toFixed(2)}</span>
          <span className="text-white/40 line-through">${retail.toFixed(2)}</span>
        </div>
      )}
    </button>
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
