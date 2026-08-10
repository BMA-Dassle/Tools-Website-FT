"use client";

import { useMemo } from "react";
import {
  type PackageDefinition,
  packageBundleTotal,
  packageRetailTotal,
} from "~/features/booking/service/packages";
import {
  livePerRacerPrice,
  packageBlockedToday,
  usePackageAvailability,
} from "./usePackageAvailability";

interface PackageCardProps {
  pkg: PackageDefinition;
  racerCount: number;
  date: string | null;
  isSelected: boolean;
  onSelect: () => void;
  /** KIOSK presentation only: collapse to a teaser banner (name · races badge ·
   *  price · "Save $X" + a one-line hook) with the description/checklist behind
   *  a "What's included" accordion — the two rich pack cards pushed the single
   *  races two screens down the portrait kiosk (owner 2026-07-18). Web omits
   *  these props and keeps today's rich card. Pricing is the SAME live
   *  usePackageAvailability values either way — displayed = charged. */
  compact?: boolean;
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
}

export function PackageCard({
  pkg,
  racerCount,
  date,
  isSelected,
  onSelect,
  compact,
  detailsOpen,
  onToggleDetails,
}: PackageCardProps) {
  const racers = Math.max(1, racerCount);
  const {
    livePrices,
    heatsByRef,
    loading: pricesLoading,
  } = usePackageAvailability(pkg, date, racers);

  // Multi-race gate + live per-racer price — the shared derivations (see
  // usePackageAvailability.ts), so this card and the pay-mode page can never
  // quote the same package differently.
  const blocked = useMemo(() => packageBlockedToday(pkg, heatsByRef), [pkg, heatsByRef]);

  const perRacer = livePrices ? livePerRacerPrice(pkg, livePrices) : packageBundleTotal(pkg, 1);
  const totalPrice = perRacer * racers;
  const retail = packageRetailTotal(pkg, racers);
  const savings = Math.max(0, retail - totalPrice);

  // Shared pieces between the rich (web) and compact (kiosk) presentations —
  // one source for the checklist/savings so the two can never drift.
  const nameRow = (
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
  );
  const priceLabel = pricesLoading ? (
    <span className="text-xs text-white/30">updating…</span>
  ) : (
    `$${totalPrice.toFixed(2)}`
  );
  const savingsRow = savings > 0 && !blocked && (
    <div className="mt-2 flex items-baseline justify-between text-xs">
      <span className="font-bold text-amber-400">You save ${savings.toFixed(2)}</span>
      <span className="text-white/40 line-through">${retail.toFixed(2)}</span>
    </div>
  );

  if (compact) {
    // One-line hook derived from the definition itself (no new data fields).
    const hook = [
      `${pkg.races.length || 1} race${(pkg.races.length || 1) === 1 ? "" : "s"}`,
      ...(pkg.includesLicense ? ["racing license"] : []),
      ...(pkg.includesPov ? ["POV race video"] : []),
      ...(pkg.appetizerCode ? ["free appetizer at Nemo's"] : []),
    ].join(" · ");
    return (
      <div
        className={`w-full rounded-xl border transition-all duration-200 ${
          blocked
            ? "border-white/10 bg-white/[0.02] opacity-60"
            : isSelected
              ? "border-2 border-amber-500/40 bg-linear-to-br from-amber-500/10 to-amber-500/5 ring-2 ring-amber-500/30 ring-offset-2 ring-offset-[#010A20]"
              : "border-amber-500/20 bg-linear-to-br from-amber-500/10 to-amber-500/5 hover:border-amber-500/40"
        }`}
      >
        {/* The whole teaser selects (same semantics as the rich card); the
            accordion below is optional reading, never a required step. Kept as
            SIBLING buttons — a nested button is invalid HTML. */}
        <button
          type="button"
          onClick={blocked ? undefined : onSelect}
          disabled={blocked}
          aria-disabled={blocked}
          className={`block w-full p-4 text-left ${blocked ? "cursor-not-allowed" : ""}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            {nameRow}
            <span className="shrink-0 text-base font-bold text-amber-400 tabular-nums">
              {priceLabel}
            </span>
          </div>
          {blocked ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-white/55">
              Not enough time left today to fit both races. Book the {pkg.name} earlier in the day,
              or choose a single race.
            </p>
          ) : (
            <p className="mt-1.5 text-xs leading-relaxed text-white/55">Includes {hook}.</p>
          )}
          {savingsRow}
        </button>
        {!blocked && (
          <>
            <button
              type="button"
              onClick={onToggleDetails}
              aria-expanded={!!detailsOpen}
              className="flex w-full items-center gap-2 border-t border-dashed border-white/10 px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-widest text-amber-300/90"
            >
              <span
                aria-hidden
                className={`inline-block transition-transform duration-150 ${detailsOpen ? "rotate-90" : ""}`}
              >
                ›
              </span>
              What&rsquo;s included
            </button>
            {detailsOpen && (
              <div className="px-4 pb-4">
                <p className="text-xs leading-relaxed text-white/50">{pkg.longDescription}</p>
                <IncludedList pkg={pkg} racers={racers} />
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={blocked ? undefined : onSelect}
      disabled={blocked}
      aria-disabled={blocked}
      className={`w-full rounded-xl border p-4 text-left transition-all duration-200 ${
        blocked
          ? "cursor-not-allowed border-white/10 bg-white/[0.02] opacity-50"
          : isSelected
            ? "border-2 border-amber-500/40 bg-linear-to-br from-amber-500/10 to-amber-500/5 ring-2 ring-amber-500/30 ring-offset-2 ring-offset-[#010A20]"
            : "border-amber-500/20 bg-linear-to-br from-amber-500/10 to-amber-500/5 hover:border-amber-500/40"
      }`}
    >
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        {nameRow}
        <span className="shrink-0 text-base font-bold text-amber-400">{priceLabel}</span>
      </div>

      <p className="text-xs leading-relaxed text-white/50">{pkg.longDescription}</p>

      <IncludedList pkg={pkg} racers={racers} />

      {savingsRow}

      {blocked && (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-white/55">
          Not enough time left today to fit both races. Book the {pkg.name} earlier in the day, or
          choose a single race.
        </div>
      )}
    </button>
  );
}

/** The green ✓ checklist (races, license, POV, appetizer) — shared verbatim by
 *  the rich card body, the compact card's accordion, and the pay-mode page's
 *  web "What's included" disclosure. */
export function IncludedList({ pkg, racers }: { pkg: PackageDefinition; racers: number }) {
  return (
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
        <li>
          <div className="flex items-baseline justify-between gap-2">
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
          </div>
          {pkg.appetizerItems && (
            <ul className="ml-5 mt-0.5 list-inside list-disc space-y-0 text-[11px] text-white/40 marker:text-amber-400/40">
              {pkg.appetizerItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </li>
      )}
    </ul>
  );
}
