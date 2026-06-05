"use client";

import { useEffect, useState } from "react";
import {
  type PackageDefinition,
  packageBundleTotal,
  packageRetailTotal,
  packageSavings,
  primaryTrack,
} from "~/features/booking/service/packages";
import { bmiAdapter } from "~/features/booking/data/bmi";

interface PackageCardProps {
  pkg: PackageDefinition;
  racerCount: number;
  date: string | null;
  isSelected: boolean;
  onSelect: () => void;
}

export function PackageCard({ pkg, racerCount, date, isSelected, onSelect }: PackageCardProps) {
  const racers = Math.max(1, racerCount);
  const { livePrices, loading: pricesLoading } = usePackageLivePrices(pkg, date);

  const perRacer = livePrices
    ? pkg.races.reduce((sum, r) => sum + (livePrices[r.ref] ?? primaryTrack(r).price), 0) +
      (pkg.includesLicense ? 4.99 : 0) +
      (pkg.includesPov ? 5 : 0)
    : packageBundleTotal(pkg, 1);
  const totalPrice = perRacer * racers;
  const retail = packageRetailTotal(pkg, racers);
  const savings = Math.max(0, retail - totalPrice);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border p-4 text-left transition-all duration-200 ${
        isSelected
          ? "border-2 border-amber-500/40 bg-linear-to-br from-amber-500/10 to-amber-500/5 ring-2 ring-amber-500/30 ring-offset-2 ring-offset-[#010A20]"
          : "border-amber-500/20 bg-linear-to-br from-amber-500/10 to-amber-500/5 hover:border-amber-500/40"
      }`}
    >
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
            {pkg.name}
          </span>
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-400">
            {pkg.races.length === 0 ? "1" : pkg.races.length} RACE
            {pkg.races.length !== 1 ? "S" : ""}
          </span>
          {racers > 1 && <span className="text-xs text-white/20">{racers} racers</span>}
        </div>
        <span className="shrink-0 text-base font-bold text-amber-400">
          {pricesLoading ? (
            <span className="text-xs text-white/30">updating…</span>
          ) : (
            `$${totalPrice.toFixed(2)}`
          )}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-white/50">{pkg.longDescription}</p>

      <ul className="mt-3 space-y-1 text-xs text-white/70">
        {pkg.races.map((r) => (
          <li key={r.ref} className="flex items-baseline justify-between gap-2">
            <span>
              <span className="text-emerald-400">✓</span> {r.label}
              {racers > 1 && <span className="text-white/40"> × {racers}</span>}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300/80">
              Included
            </span>
          </li>
        ))}
        {pkg.includesLicense && (
          <li className="flex items-baseline justify-between gap-2">
            <span>
              <span className="text-emerald-400">✓</span> Racing License
              {racers > 1 && <span className="text-white/40"> × {racers}</span>}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300/80">
              Included
            </span>
          </li>
        )}
        {pkg.includesPov && (
          <li className="flex items-baseline justify-between gap-2">
            <span>
              <span className="text-emerald-400">✓</span> POV Race Video
              {racers > 1 && <span className="text-white/40"> × {racers}</span>}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300/80">
              Included
            </span>
          </li>
        )}
        {pkg.appetizerCode && (
          <li className="flex items-baseline justify-between gap-2">
            <span>
              <span className="text-emerald-400">✓</span> Free Appetizer at Nemo&apos;s
              <span className="text-white/40">
                {" "}
                ({pkg.appetizerNote ?? "1 per group"} · race day only)
              </span>
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
              Included
            </span>
          </li>
        )}
      </ul>

      {savings > 0 && (
        <div className="mt-2 flex items-baseline justify-between text-xs">
          <span className="font-bold text-amber-400">You save ${savings.toFixed(2)}</span>
          <span className="text-white/40 line-through">${retail.toFixed(2)}</span>
        </div>
      )}
    </button>
  );
}

function usePackageLivePrices(
  pkg: PackageDefinition,
  date: string | null,
): { livePrices: Record<string, number> | null; loading: boolean } {
  const [livePrices, setLivePrices] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!date || pkg.races.length === 0) return;
    let cancelled = false;
    setLoading(true);

    (async () => {
      const prices: Record<string, number> = {};
      for (const race of pkg.races) {
        const track = primaryTrack(race);
        try {
          const avail = await bmiAdapter.getAvailability({
            date,
            productId: track.productId,
            pageId: track.pageId,
            quantity: 1,
          });
          const firstBlock = avail.proposals?.[0]?.blocks?.[0]?.block;
          const cashPrice = firstBlock?.prices?.find((p) => p.depositKind === 0);
          if (cashPrice) {
            prices[race.ref] = cashPrice.amount;
          }
        } catch {
          /* fallback to registry price */
        }
      }
      if (!cancelled) {
        setLivePrices(Object.keys(prices).length > 0 ? prices : null);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [date, pkg.id, pkg.races]);

  return { livePrices, loading };
}
